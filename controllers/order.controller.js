// controllers/order.controller.js
const Order = require('../models/Order');
const Address = require('../models/Address');
const Cart = require('../models/cart');
const CheckoutQuote = require('../models/CheckoutQuote');
const Product = require('../models/Product');
const Coupon = require('../models/Coupon');
const OrderIdempotencyKey = require('../models/OrderIdempotencyKey');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const mongoose = require('mongoose');
const ShiprocketService = require('../utils/shiprocket');
const logger = require('../utils/logger');
const {
    computeCheckoutTotals,
    cartFingerprintFromItems,
    roundMoney2
} = require('../services/checkoutComputation.service');
const { releaseReservedInventoryForOrder } = require('../services/orderInventory.service');
const paymentHoldExpiryService = require('../services/paymentHoldExpiry.service');
const {
    normalizePaymentMethod,
    normalizePaymentPlan,
    ALLOWED_ADVANCE_PAYMENT_PERCENTS,
    normalizeAdvancePaymentPercent,
    resolveDefaultAdvancePercent,
    normalizeIdempotencyKey,
    createInvalidPaymentMethodError,
    createQuoteExpiredError,
    createQuoteStaleError,
    createCheckoutFlowError,
    sendCheckoutFlowError,
    isOrderStaffRequest,
    buildRequestLogContext
} = require('../utils/checkoutFlow');

const normalizeDecisionCode = (errorLike, fallback) =>
    String(errorLike?.code || fallback || 'ORDER_FLOW_ERROR').trim().toUpperCase();

// Initialize Razorpay (trim — stray spaces/newlines in .env break auth)
const razorpay = new Razorpay({
    key_id: String(process.env.RAZORPAY_KEY_ID || '').trim(),
    key_secret: String(process.env.RAZORPAY_KEY_SECRET || '').trim()
});

async function applyRefundEntryToOrder(order, refundEntity) {
    if (!order || !refundEntity) return;
    const amountPaise = Number(refundEntity.amount);
    if (!Number.isFinite(amountPaise) || amountPaise <= 0) return;
    const amountInr = roundMoney2(amountPaise / 100);
    const entry = {
        refundId: refundEntity.id,
        amountInr,
        amountPaise,
        status: refundEntity.status || 'processed',
        reason: (refundEntity.notes && refundEntity.notes.reason) || '',
        createdAt: new Date()
    };
    order.refundHistory = order.refundHistory || [];
    if (!order.refundHistory.some((r) => r.refundId === entry.refundId)) {
        order.refundHistory.push(entry);
    }

    const totalRefundedInr = roundMoney2(
        (order.refundHistory || []).reduce((s, r) => s + (Number(r.amountInr) || 0), 0)
    );
    if (totalRefundedInr >= roundMoney2(order.totalAmount)) {
        order.paymentStatus = 'refunded';
    } else if (totalRefundedInr > 0) {
        order.paymentStatus = 'partially_refunded';
    }
    order.returnInfo = {
        ...(order.returnInfo || {}),
        refundAmount: totalRefundedInr,
        refundId: entry.refundId,
        status: entry.status
    };
    await order.save();
}

async function abortTransactionSafely(session) {
    if (!session?.inTransaction()) return;
    try {
        await session.abortTransaction();
    } catch (_) {
        // Swallow abort failures to preserve the original controller error.
    }
}

function generateOrderIdCandidate() {
    if (typeof crypto.randomUUID === 'function') {
        return `ORD-${crypto.randomUUID().replace(/-/g, '').slice(0, 18).toUpperCase()}`;
    }
    return `ORD-${crypto.randomBytes(10).toString('hex').toUpperCase()}`;
}

function isOrderIdDuplicateError(error) {
    if (!error || error.code !== 11000) return false;
    const dup = error.keyPattern?.orderId || error.keyValue?.orderId;
    return Boolean(dup);
}

async function reserveInventoryAtomically(lines, session) {
    for (const line of lines) {
        const variant = line?.variant;
        const product = line?.product;

        if (!product?._id || !variant?._id) {
            throw createCheckoutFlowError({
                statusCode: 500,
                code: 'ORDER_LINE_INVALID',
                message: 'Order line is missing product or variant information'
            });
        }

        if (variant.inventory?.trackInventory === false) {
            continue;
        }

        const requestedQty = Number(line.quantity);
        if (!Number.isFinite(requestedQty) || requestedQty <= 0) {
            throw createCheckoutFlowError({
                statusCode: 400,
                code: 'ORDER_LINE_QUANTITY_INVALID',
                message: 'Order line quantity must be greater than 0'
            });
        }

        const reserveResult = await Product.updateOne(
            {
                _id: product._id,
                variants: {
                    $elemMatch: {
                        _id: variant._id,
                        'inventory.trackInventory': true,
                        'inventory.quantity': { $gte: requestedQty }
                    }
                }
            },
            {
                $inc: { 'variants.$.inventory.quantity': -requestedQty }
            }
        ).session(session);

        if (reserveResult.modifiedCount !== 1) {
            throw createCheckoutFlowError({
                statusCode: 409,
                code: 'INSUFFICIENT_STOCK_RACE',
                message: `${product.name || 'Product'} stock changed during checkout. Please refresh your cart and try again.`,
                details: {
                    productId: String(product._id),
                    variantId: String(variant._id),
                    requestedQuantity: requestedQty
                }
            });
        }
    }
}

function buildUnauthorizedOrderResponse(res) {
    return res.status(403).json({
        success: false,
        code: 'ORDER_ACCESS_DENIED',
        message: 'Unauthorized'
    });
}

function respondOrderError(res, statusCode, code, message, extras = {}) {
    return res.status(statusCode).json({
        success: false,
        code,
        message,
        ...extras
    });
}

/** ObjectId or populated user doc → string id; null if order has no buyer (legacy / bad row). */
function normalizeOrderUserId(order) {
    if (!order || order.userId == null) return null;
    const u = order.userId;
    if (typeof u === 'object' && u._id != null) return String(u._id);
    return String(u);
}

/**
 * Read access: staff may view any order in scope; customers only their own.
 * Must not call .toString() on null userId; staff branch must not depend on owner id.
 */
function canViewOrderForRequest(req, order, isOrderStaff) {
    if (isOrderStaff) return true;
    const ownerId = normalizeOrderUserId(order);
    if (!ownerId) return false;
    const requesterId = req.userId != null ? String(req.userId) : null;
    return Boolean(requesterId && ownerId === requesterId);
}

function buildOrderResponsePayload(order, {
    normalizedPaymentMethod,
    discount,
    splitMode,
    advancePercent = null,
    appliedCouponCode,
    razorpayOrder = null,
    idempotentReplay = false
}) {
    return {
        success: true,
        message: normalizedPaymentMethod === 'cod' ? 'Order placed successfully' : 'Order created. Complete payment to confirm.',
        order: {
            orderId: order.orderId,
            totalAmount: order.totalAmount,
            subtotal: order.subtotal,
            tax: order.tax,
            discount: discount ?? order.discount ?? 0,
            orderStatus: order.orderStatus,
            paymentStatus: order.paymentStatus,
            balanceDueInr: order.balanceDueInr,
            onlinePaymentMode: splitMode || order.paymentInfo?.splitMode || 'full',
            paymentAdvancePercent:
                advancePercent ??
                order.paymentInfo?.advancePercent ??
                null
        },
        appliedCoupon: appliedCouponCode ?? order.appliedCoupon?.code ?? null,
        razorpayOrder: razorpayOrder ? {
            id: razorpayOrder.id,
            amount: razorpayOrder.amount,
            currency: razorpayOrder.currency
        } : null,
        paymentMethod: normalizedPaymentMethod,
        idempotentReplay
    };
}

async function resolveIdempotencyRecord({ req, body }) {
    const idempotencyKey = normalizeIdempotencyKey(req.headers['idempotency-key']);
    if (!idempotencyKey) {
        return { enabled: false, record: null, normalizedKey: null };
    }

    const requestHash = OrderIdempotencyKey.buildRequestHash({
        addressId: body.addressId || null,
        paymentMethod: body.paymentMethod || null,
        couponCode: body.couponCode || null,
        onlinePaymentMode: body.onlinePaymentMode || 'full',
        paymentAdvancePercent: body.paymentAdvancePercent || null,
        quoteId: body.quoteId || null
    });

    let record = await OrderIdempotencyKey.findOne({ userId: req.userId, key: idempotencyKey });
    let createdNow = false;

    if (!record) {
        try {
            record = await OrderIdempotencyKey.create({
                userId: req.userId,
                key: idempotencyKey,
                requestHash,
                status: 'pending'
            });
            createdNow = true;
        } catch (error) {
            if (error?.code !== 11000) {
                throw error;
            }
            record = await OrderIdempotencyKey.findOne({ userId: req.userId, key: idempotencyKey });
        }
    }

    if (record.requestHash !== requestHash) {
        throw createCheckoutFlowError({
            statusCode: 409,
            code: 'IDEMPOTENCY_KEY_REUSED',
            message: 'This Idempotency-Key is already used for a different order request.',
            details: { key: idempotencyKey }
        });
    }

    if (record.status === 'completed' && record.orderId) {
        const existingOrder = await Order.findOne({ orderId: record.orderId, userId: req.userId });
        if (!existingOrder) {
            logger.warn('Idempotency record points to missing order', buildRequestLogContext(req, {
                idempotencyKey,
                orderId: record.orderId
            }));
            await OrderIdempotencyKey.deleteOne({ _id: record._id });
            record = await OrderIdempotencyKey.create({
                userId: req.userId,
                key: idempotencyKey,
                requestHash,
                status: 'pending'
            });
            createdNow = true;
        } else {
            return {
                enabled: true,
                normalizedKey: idempotencyKey,
                requestHash,
                record,
                existingOrder
            };
        }
    }

    const pendingAgeMs = record.createdAt ? Date.now() - record.createdAt.getTime() : 0;
    if (!createdNow && record.status === 'pending' && pendingAgeMs <= 10 * 60 * 1000) {
        const lockIsFresh = record.updatedAt ? Date.now() - record.updatedAt.getTime() <= 60 * 1000 : true;
        if (lockIsFresh) {
            throw createCheckoutFlowError({
                statusCode: 409,
                code: 'IDEMPOTENCY_REQUEST_IN_PROGRESS',
                message: 'An order request with this Idempotency-Key is already being processed.',
                details: { key: idempotencyKey }
            });
        }
    }

    if (record.status === 'pending') {
        record.requestHash = requestHash;
        record.updatedAt = new Date();
        await record.save();
    }

    return {
        enabled: true,
        normalizedKey: idempotencyKey,
        requestHash,
        record,
        existingOrder: null
    };
}

// ========== MAIN ORDER CREATION API ==========
// ========== MAIN ORDER CREATION API ==========
exports.createOrder = async (req, res) => {
    logger.debug('Create order request received', buildRequestLogContext(req));
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        // Never trust client totals — only address, payment channel, user type, coupon code, Razorpay split mode
        const { addressId, paymentMethod, couponCode, onlinePaymentMode = 'full', paymentAdvancePercent, quoteId } = req.body || {};
        const idempotency = await resolveIdempotencyRecord({ req, body: req.body || {} });
        if (idempotency.existingOrder) {
            logger.info('Replaying existing order for idempotent request', buildRequestLogContext(req, {
                idempotencyKey: idempotency.normalizedKey,
                orderId: idempotency.existingOrder.orderId
            }));
            return res.status(200).json(
                buildOrderResponsePayload(idempotency.existingOrder, {
                    normalizedPaymentMethod: idempotency.existingOrder.paymentInfo?.method || 'online',
                    discount: idempotency.existingOrder.discount,
                    splitMode: idempotency.existingOrder.paymentInfo?.splitMode,
                    advancePercent: idempotency.existingOrder.paymentInfo?.advancePercent ?? null,
                    appliedCouponCode: idempotency.existingOrder.appliedCoupon?.code || null,
                    razorpayOrder: idempotency.existingOrder.paymentInfo?.razorpayOrderId
                        ? {
                            id: idempotency.existingOrder.paymentInfo.razorpayOrderId,
                            amount: idempotency.existingOrder.paymentInfo?.amountPaise || null,
                            currency: 'INR'
                        }
                        : null,
                    idempotentReplay: true
                })
            );
        }

        const userId = req.userId;
        const finalUserType = req.userType === 'wholesaler' ? 'wholesaler' : 'normal';
        const storefront = req.storefront || 'ecomm';
        const normalizedPaymentMethod = normalizePaymentMethod(paymentMethod);
        if (!normalizedPaymentMethod) {
            throw createInvalidPaymentMethodError();
        }
        const normalizedOnlinePaymentMode = normalizePaymentPlan(onlinePaymentMode);
        const hasAdvancePercentInput =
            paymentAdvancePercent !== undefined &&
            paymentAdvancePercent !== null &&
            String(paymentAdvancePercent).trim() !== '';
        const normalizedAdvancePercent = normalizeAdvancePaymentPercent(paymentAdvancePercent);
        if (normalizedOnlinePaymentMode === 'advance' && hasAdvancePercentInput && normalizedAdvancePercent == null) {
            await abortTransactionSafely(session);
            if (idempotency.enabled) {
                await OrderIdempotencyKey.deleteOne({ _id: idempotency.record._id });
            }
            return res.status(400).json({
                success: false,
                code: 'INVALID_ADVANCE_PERCENT',
                message: `paymentAdvancePercent must be one of: ${ALLOWED_ADVANCE_PAYMENT_PERCENTS.join(', ')}`
            });
        }

        if (!quoteId) {
            await abortTransactionSafely(session);
            if (idempotency.enabled) {
                await OrderIdempotencyKey.deleteOne({ _id: idempotency.record._id });
            }
            return res.status(400).json({
                success: false,
                code: 'QUOTE_ID_REQUIRED',
                message: 'quoteId is required. Generate and confirm checkout quote before placing order.'
            });
        }
        if (!mongoose.Types.ObjectId.isValid(String(quoteId))) {
            await abortTransactionSafely(session);
            if (idempotency.enabled) {
                await OrderIdempotencyKey.deleteOne({ _id: idempotency.record._id });
            }
            return res.status(400).json({
                success: false,
                code: 'INVALID_QUOTE_ID',
                message: 'Invalid quoteId'
            });
        }
        if (!addressId || !mongoose.Types.ObjectId.isValid(String(addressId))) {
            await abortTransactionSafely(session);
            if (idempotency.enabled) {
                await OrderIdempotencyKey.deleteOne({ _id: idempotency.record._id });
            }
            return res.status(400).json({
                success: false,
                code: 'INVALID_ADDRESS_ID',
                message: 'Invalid addressId'
            });
        }

        // 1. Validate address
        const address = await Address.findById(addressId).session(session);
        if (!address) {
            await abortTransactionSafely(session);
            if (idempotency.enabled) {
                await OrderIdempotencyKey.deleteOne({ _id: idempotency.record._id });
            }
            return res.status(404).json({
                success: false,
                code: 'ADDRESS_NOT_FOUND',
                message: 'Address not found'
            });
        }

        if (String(address.userId) !== String(userId)) {
            await abortTransactionSafely(session);
            if (idempotency.enabled) {
                await OrderIdempotencyKey.deleteOne({ _id: idempotency.record._id });
            }
            return res.status(403).json({
                success: false,
                code: 'ADDRESS_OWNERSHIP_MISMATCH',
                message: 'Address does not belong to this user'
            });
        }

        // 2. Get user's cart
        const cartDoc = await Cart.findOne({ userId }).session(session);
        if (!cartDoc || !cartDoc.items || cartDoc.items.length === 0) {
            await abortTransactionSafely(session);
            if (idempotency.enabled) {
                await OrderIdempotencyKey.deleteOne({ _id: idempotency.record._id });
            }
            return res.status(400).json({
                success: false,
                code: 'CART_EMPTY',
                message: 'cart is empty'
            });
        }

        const normalizePin = (p) => String(p || '').replace(/\D/g, '').slice(0, 6);
        const pin = normalizePin(address.postalCode);
        if (pin.length !== 6) {
            await abortTransactionSafely(session);
            if (idempotency.enabled) {
                await OrderIdempotencyKey.deleteOne({ _id: idempotency.record._id });
            }
            return res.status(400).json({
                success: false,
                code: 'INVALID_POSTAL_CODE',
                message: 'Address must include a valid 6-digit postal code'
            });
        }

        const fp = cartFingerprintFromItems(cartDoc.items);
        const quote = await CheckoutQuote.findOne({ _id: quoteId, userId }).session(session);
        if (!quote) {
            await abortTransactionSafely(session);
            if (idempotency.enabled) {
                await OrderIdempotencyKey.deleteOne({ _id: idempotency.record._id });
            }
            return res.status(404).json({
                success: false,
                code: 'QUOTE_NOT_FOUND',
                message: 'Checkout quote not found'
            });
        }
        if (quote.status !== 'confirmed') {
            throw createQuoteStaleError('quote_not_confirmed', {
                message: 'Checkout quote is not confirmed. Please confirm quote before placing order.'
            });
        }
        if (quote.quoteExpiresAt.getTime() <= Date.now()) {
            throw createQuoteExpiredError();
        }
        if (String(quote.addressId) !== String(addressId)) {
            throw createQuoteStaleError('address_changed', {
                message: 'Address changed after quote confirmation. Please refresh quote before proceeding.'
            });
        }
        if (normalizePin(quote.postalCode) !== pin) {
            throw createQuoteStaleError('address_changed', {
                message: 'Pincode changed after quote confirmation. Please refresh quote before proceeding.'
            });
        }
        if (String(quote.cartFingerprint) !== String(fp)) {
            throw createQuoteStaleError('cart_changed', {
                message: 'Cart changed after quote confirmation. Please refresh quote before proceeding.'
            });
        }
        if (String(quote.couponCodeUpper || '') !== String((couponCode || '')).toUpperCase().trim()) {
            throw createQuoteStaleError('coupon_changed', {
                message: 'Coupon changed after quote confirmation. Please refresh quote before proceeding.'
            });
        }
        if (normalizedPaymentMethod === 'cod' && quote.shippingMeta?.codAvailable === false) {
            await abortTransactionSafely(session);
            if (idempotency.enabled) {
                await OrderIdempotencyKey.deleteOne({ _id: idempotency.record._id });
            }
            return res.status(400).json({
                success: false,
                code: 'COD_NOT_AVAILABLE',
                message: 'COD is not available for this quote'
            });
        }

        const deliveryOverride = {
            charges: Number(quote.deliveryCharges) || 0,
            meta: {
                estimatedDays: quote.shippingMeta?.estimatedDays || null,
                courierName: quote.shippingMeta?.courierName || null,
                isDeliverable: true,
                codAvailable: quote.shippingMeta?.codAvailable !== false,
                // mock: Boolean(quote.shippingMeta?.mock)
            }
        };

        const buildTotals = async (consumeCoupon, codAmt) =>
            computeCheckoutTotals({
                cart: cartDoc,
                postalCode: pin,
                finalUserType,
                storefront,
                couponCode,
                session,
                consumeCoupon,
                codAmountForShiprocket: codAmt,
                deliveryChargesOverride: deliveryOverride ? deliveryOverride.charges : null,
                deliveryMetaOverride: deliveryOverride ? deliveryOverride.meta : null
            });

        let last;
        let priced;
        try {
            if (normalizedPaymentMethod === 'cod') {
                last = await buildTotals(false, 0);
                for (let i = 0; i < 2; i++) {
                    const codVal = roundMoney2(last.subtotal + last.tax - last.discount + last.deliveryCharges);
                    last = await buildTotals(false, codVal);
                }
            } else {
                last = await buildTotals(false, 0);
            }

            priced = await buildTotals(
                true,
                normalizedPaymentMethod === 'cod'
                    ? roundMoney2(last.subtotal + last.tax - last.discount + last.deliveryCharges)
                    : 0
            );
        } catch (e) {
            await abortTransactionSafely(session);
            session.endSession();
            return sendCheckoutFlowError(res, e, 'Checkout validation failed', 'ORDER_CHECKOUT_VALIDATION_FAILED');
        }

        const { orderItems, subtotal, deliveryCharges, tax, discount, appliedCouponCode, totalAmount, lines } = priced;
        const quoteTotalsMismatch =
            roundMoney2(quote.itemsSubtotal) !== roundMoney2(subtotal) ||
            roundMoney2(quote.promotionDiscount) !== roundMoney2(discount) ||
            roundMoney2(quote.deliveryCharges) !== roundMoney2(deliveryCharges) ||
            roundMoney2(quote.taxes) !== roundMoney2(tax) ||
            roundMoney2(quote.amountPayable) !== roundMoney2(totalAmount);

        if (quoteTotalsMismatch) {
            throw createQuoteStaleError('pricing_changed', {
                message: 'Pricing changed after quote confirmation. Please refresh quote before placing order.',
                details: {
                    latest: {
                        itemsSubtotal: subtotal,
                        promotionDiscount: discount,
                        deliveryCharges,
                        taxes: tax,
                        amountPayable: totalAmount,
                        codAvailable: quote.shippingMeta?.codAvailable !== false
                    }
                }
            });
        }

        await reserveInventoryAtomically(lines, session);

        const defaultAdvancePercent = resolveDefaultAdvancePercent();
        const advancePercent = normalizedAdvancePercent || defaultAdvancePercent;
        let razorpayChargePaise = Math.round(roundMoney2(totalAmount) * 100);
        let splitMode = 'full';
        let balanceDueInr = 0;
        let amountPaidInr = 0;

        if (normalizedPaymentMethod === 'online' && String(normalizedOnlinePaymentMode).toLowerCase() === 'advance') {
            const totalInr = roundMoney2(totalAmount);
            const advInrRaw = roundMoney2((totalInr * advancePercent) / 100);
            const advInr = Math.max(1, Math.min(roundMoney2(totalInr - 0.01), advInrRaw));
            if (advInr < totalInr - 0.001) {
                splitMode = 'advance';
                razorpayChargePaise = Math.round(advInr * 100);
                balanceDueInr = roundMoney2(totalInr - advInr);
            }
        }

        const orderPayload = {
            userId: userId,
            items: orderItems,
            subtotal: subtotal,
            deliveryCharges: deliveryCharges,
            tax: tax,
            discount: discount,
            totalAmount: totalAmount,
            address: addressId,
            addressSnapshot: address.toObject(),
            userType: finalUserType,
            orderStatus: normalizedPaymentMethod === 'cod' ? 'confirmed' : 'pending',
            paymentStatus: normalizedPaymentMethod === 'cod' ? 'pending' : 'pending',
            amountPaidInr,
            balanceDueInr,
            appliedCoupon: appliedCouponCode
                ? { code: appliedCouponCode, discount }
                : { code: null, discount: 0 },
            paymentInfo: {
                method: normalizedPaymentMethod,
                status: 'initiated',
                amountPaise: razorpayChargePaise,
                splitMode,
                advancePercent: splitMode === 'advance' ? advancePercent : null,
                fullOrderAmountPaise: Math.round(roundMoney2(totalAmount) * 100),
                quoteId: String(quote._id),
                sessions: []
            }
        };

        // 9. Create order with collision-safe orderId retries.
        let order = null;
        let orderSaved = false;
        for (let attempt = 0; attempt < 5; attempt++) {
            const candidateOrderId = generateOrderIdCandidate();
            order = new Order({
                orderId: candidateOrderId,
                ...orderPayload
            });
            try {
                await order.save({ session });
                orderSaved = true;
                break;
            } catch (saveError) {
                if (isOrderIdDuplicateError(saveError)) {
                    continue;
                }
                throw saveError;
            }
        }
        if (!orderSaved || !order) {
            throw createCheckoutFlowError({
                statusCode: 503,
                code: 'ORDER_ID_GENERATION_FAILED',
                message: 'Could not allocate a unique order ID. Please retry checkout.'
            });
        }

        if (normalizedPaymentMethod === 'online') {
            order.paymentHoldExpiresAt = new Date(Date.now() + paymentHoldExpiryService.getPaymentHoldMs());
        }

        // 10. Clear cart
        cartDoc.items = [];
        cartDoc.totalAmount = 0;
        cartDoc.deliverySnapshot = null;
        await cartDoc.save({ session });

        quote.status = 'consumed';
        quote.lastValidatedAt = new Date();
        await quote.save({ session });

        await session.commitTransaction();
        session.endSession();

        if (idempotency.enabled) {
            await OrderIdempotencyKey.updateOne(
                { _id: idempotency.record._id },
                {
                    $set: {
                        status: 'completed',
                        orderId: order.orderId,
                        completedAt: new Date()
                    }
                }
            );
        }

        // 11. If online payment, create Razorpay order (amount in paise must match verify/webhook logic)
        let razorpayOrder = null;
        if (normalizedPaymentMethod === 'online') {
            const amountPaise = razorpayChargePaise;
            if (!String(process.env.RAZORPAY_KEY_ID || '').trim() || !String(process.env.RAZORPAY_KEY_SECRET || '').trim()) {
                console.error('Razorpay: RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET missing in env');
                return res.status(201).json({
                    success: true,
                    message: 'Order created but payment initiation failed. Please try again.',
                    order: {
                        orderId: order.orderId,
                        totalAmount: order.totalAmount,
                        subtotal: order.subtotal,
                        tax: order.tax,
                        discount: order.discount
                    },
                    razorpayError: true,
                    razorpayErrorDetail: {
                        description: 'Server env: set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET (test keys from Razorpay Dashboard).',
                        code: 'MISSING_RAZORPAY_ENV',
                        statusCode: null
                    }
                });
            }
            try {
                razorpayOrder = await razorpay.orders.create({
                    amount: amountPaise,
                    currency: 'INR',
                    receipt: order.orderId.slice(0, 40),
                    payment_capture: 1,
                    notes: {
                        orderId: order.orderId,
                        userId: String(userId)
                    }
                });

                order.paymentInfo.razorpayOrderId = razorpayOrder.id;
                order.paymentInfo.amountPaise = razorpayOrder.amount;
                order.paymentInfo.status = 'created';
                order.paymentInfo.sessions = [
                    {
                        razorpayOrderId: razorpayOrder.id,
                        expectedAmountPaise: Number(razorpayOrder.amount),
                        status: 'created'
                    }
                ];
                order.markModified('paymentInfo');
                await order.save();
            } catch (razorpayError) {
                console.error('Razorpay order creation failed:', razorpayError);
                const body = razorpayError && (razorpayError.error || razorpayError);
                const description =
                    (body && (body.description || body.message)) ||
                    razorpayError?.message ||
                    'Razorpay API rejected the request';
                const code = body && body.code ? body.code : null;
                const statusCode = razorpayError && razorpayError.statusCode != null ? razorpayError.statusCode : null;
                return res.status(201).json({
                    success: true,
                    message: 'Order created but payment initiation failed. Please try again.',
                    order: {
                        orderId: order.orderId,
                        totalAmount: order.totalAmount,
                        subtotal: order.subtotal,
                        tax: order.tax,
                        discount: order.discount
                    },
                    razorpayError: true,
                    razorpayErrorDetail: {
                        description,
                        code,
                        statusCode,
                        hint: 'Use matching rzp_test_* key id and secret from the same Razorpay Dashboard mode; restart the server after editing .env.'
                    }
                });
            }
        }
        
        logger.info('Order created successfully', buildRequestLogContext(req, {
            orderId: order.orderId,
            quoteId: String(quote._id),
            paymentMethod: normalizedPaymentMethod
        }));
        
        return res.status(201).json(
            buildOrderResponsePayload(order, {
                normalizedPaymentMethod,
                discount,
                splitMode,
                advancePercent: splitMode === 'advance' ? advancePercent : null,
                appliedCouponCode,
                razorpayOrder
            })
        );

    } catch (error) {
        await abortTransactionSafely(session);
        session.endSession();
        const idempotencyKey = normalizeIdempotencyKey(req.headers['idempotency-key']);
        if (idempotencyKey) {
            try {
                await OrderIdempotencyKey.deleteOne({
                    userId: req.userId,
                    key: idempotencyKey,
                    status: 'pending'
                });
            } catch (cleanupError) {
                logger.warn('Failed to clean pending idempotency key after createOrder error', buildRequestLogContext(req, {
                    idempotencyKey,
                    error: cleanupError.message
                }));
            }
        }
        if (error?.statusCode) {
            logger.warn('createOrder business rejection', buildRequestLogContext(req, {
                code: normalizeDecisionCode(error, 'ORDER_CREATE_REJECTED'),
                reason: error?.details?.reason || null,
                statusCode: error.statusCode
            }));
            return sendCheckoutFlowError(res, error, 'Error creating order', 'ORDER_CREATE_FAILED');
        }
        logger.error('Create order error', buildRequestLogContext(req, {
            error: error.message,
            stack: error.stack
        }));
        return res.status(500).json({
            success: false,
            code: 'ORDER_CREATE_FAILED',
            message: 'Error creating order',
            error: error.message
        });
    }
};

// ========== VERIFY PAYMENT ==========
exports.verifyPayment = async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature, orderId } = req.body || {};

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !orderId) {
            return respondOrderError(
                res,
                400,
                'PAYMENT_VERIFY_PAYLOAD_INVALID',
                'razorpay_order_id, razorpay_payment_id, razorpay_signature and orderId are required'
            );
        }

        const body = razorpay_order_id + "|" + razorpay_payment_id;
        const keySecret = String(process.env.RAZORPAY_KEY_SECRET || '').trim();
        const expectedSignature = crypto
            .createHmac('sha256', keySecret)
            .update(body)
            .digest('hex');

        if (expectedSignature !== razorpay_signature) {
            return respondOrderError(res, 400, 'PAYMENT_SIGNATURE_INVALID', 'Invalid payment signature');
        }

        const order = await Order.findOne({ orderId: orderId });
        if (!order) {
            return respondOrderError(res, 404, 'ORDER_NOT_FOUND', 'Order not found');
        }

        const paymentOwnerId = normalizeOrderUserId(order);
        if (!paymentOwnerId || paymentOwnerId !== String(req.userId)) {
            return respondOrderError(res, 403, 'ORDER_ACCESS_DENIED', 'Unauthorized');
        }

        order.paymentInfo = order.paymentInfo || {};
        order.paymentInfo.capturedPaymentIds = order.paymentInfo.capturedPaymentIds || [];
        if (order.paymentInfo.capturedPaymentIds.includes(razorpay_payment_id)) {
            return res.json({
                success: true,
                message: 'Payment already verified',
                order: {
                    orderId: order.orderId,
                    orderStatus: order.orderStatus,
                    paymentStatus: order.paymentStatus,
                    balanceDueInr: order.balanceDueInr
                }
            });
        }

        const sessionMatches =
            order.paymentInfo?.razorpayOrderId === razorpay_order_id ||
            (Array.isArray(order.paymentInfo?.sessions) &&
                order.paymentInfo.sessions.some((s) => s.razorpayOrderId === razorpay_order_id));
        if (!sessionMatches) {
            return respondOrderError(res, 400, 'PAYMENT_ORDER_MISMATCH', 'Payment does not match this order');
        }

        if (order.paymentStatus === 'paid' && order.orderStatus === 'confirmed') {
            return res.json({
                success: true,
                message: 'Payment verified successfully',
                order: {
                    orderId: order.orderId,
                    orderStatus: order.orderStatus,
                    paymentStatus: order.paymentStatus
                }
            });
        }

        const payment = await razorpay.payments.fetch(razorpay_payment_id);
        if (payment.order_id !== razorpay_order_id) {
            return respondOrderError(res, 400, 'PAYMENT_ORDER_MISMATCH', 'Payment and order mismatch');
        }

        const rpOrder = await razorpay.orders.fetch(razorpay_order_id);
        if (rpOrder?.notes?.orderId && rpOrder.notes.orderId !== order.orderId) {
            return respondOrderError(res, 400, 'PAYMENT_NOT_LINKED_TO_ORDER', 'Razorpay order is not linked to this checkout');
        }

        const expectedPaise = Number(rpOrder.amount);
        const paidPaise = Number(payment.amount);
        if (!Number.isFinite(paidPaise) || !Number.isFinite(expectedPaise) || paidPaise !== expectedPaise) {
            return respondOrderError(
                res,
                400,
                'PAYMENT_AMOUNT_MISMATCH',
                'Paid amount does not match Razorpay order (server-validated)'
            );
        }

        if (payment.status !== 'captured') {
            if (payment.status === 'authorized') {
                order.paymentInfo = order.paymentInfo || {};
                order.paymentInfo.status = 'authorized';
                order.paymentInfo.authorizedPaymentId = razorpay_payment_id;
                order.paymentInfo.authorizedAt = new Date();
                if (Array.isArray(order.paymentInfo.sessions)) {
                    const s = order.paymentInfo.sessions.find((x) => x.razorpayOrderId === razorpay_order_id);
                    if (s) {
                        s.status = 'authorized';
                        s.razorpayPaymentId = razorpay_payment_id;
                        s.authorizedAt = new Date();
                    }
                }
                order.markModified('paymentInfo');
                await order.save();

                return res.status(409).json({
                    success: false,
                    code: 'PAYMENT_NOT_CAPTURED_YET',
                    message: 'Payment is authorized but not captured yet. Please retry after capture confirmation.',
                    details: {
                        paymentStatus: payment.status,
                        orderId: order.orderId
                    }
                });
            }

            return res.status(400).json({
                success: false,
                code: 'PAYMENT_NOT_COMPLETED',
                message: `Payment not completed (status: ${payment.status})`
            });
        }

        const paidInr = roundMoney2(paidPaise / 100);
        order.amountPaidInr = roundMoney2((order.amountPaidInr || 0) + paidInr);
        order.balanceDueInr = roundMoney2(order.totalAmount - order.amountPaidInr);

        if (order.balanceDueInr <= 0.005) {
            order.paymentStatus = 'paid';
            order.orderStatus = 'confirmed';
            order.balanceDueInr = 0;
        } else {
            order.paymentStatus = 'partially_paid';
            order.orderStatus = 'confirmed';
        }

        order.paymentInfo = order.paymentInfo || {};
        order.paymentInfo.razorpayPaymentId = razorpay_payment_id;
        order.paymentInfo.razorpaySignature = razorpay_signature;
        order.paymentInfo.status = 'success';
        order.paymentInfo.paidAt = new Date();
        order.paymentInfo.amountPaise = paidPaise;
        if (Array.isArray(order.paymentInfo.sessions)) {
            const s = order.paymentInfo.sessions.find((x) => x.razorpayOrderId === razorpay_order_id);
            if (s) {
                s.status = 'paid';
                s.razorpayPaymentId = razorpay_payment_id;
                s.paidAt = new Date();
            }
        }

        order.paymentInfo.capturedPaymentIds.push(razorpay_payment_id);

        order.markModified('paymentInfo');
        await order.save();

        if (order.paymentStatus === 'paid' && !order.shipmentInfo?.trackingNumber) {
            ShiprocketService.createShipment(order).catch((err) => {
                console.error('Shipment creation failed:', err);
            });
        }

        return res.json({
            success: true,
            message: 'Payment verified successfully',
            order: {
                orderId: order.orderId,
                orderStatus: order.orderStatus,
                paymentStatus: order.paymentStatus,
                balanceDueInr: order.balanceDueInr
            }
        });

    } catch (error) {
        console.error('Payment verification error:', error);
        return respondOrderError(res, 500, 'PAYMENT_VERIFY_FAILED', 'Error verifying payment');
    }
};

// ========== RAZORPAY WEBHOOK (mount with express.raw in index.js) ==========
exports.razorpayWebhook = async (req, res) => {
    try {
        const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
        if (!webhookSecret) {
            console.error('RAZORPAY_WEBHOOK_SECRET is not set');
            return respondOrderError(res, 500, 'WEBHOOK_NOT_CONFIGURED', 'Webhook not configured');
        }

        const webhookSignature = req.headers['x-razorpay-signature'];
        const rawBody = Buffer.isBuffer(req.body)
            ? req.body
            : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}), 'utf8');

        const expectedSignature = crypto
            .createHmac('sha256', webhookSecret)
            .update(rawBody)
            .digest('hex');

        if (!webhookSignature || expectedSignature.length !== webhookSignature.length) {
            return respondOrderError(res, 400, 'WEBHOOK_SIGNATURE_INVALID', 'Invalid webhook signature');
        }

        try {
            if (!crypto.timingSafeEqual(Buffer.from(expectedSignature, 'utf8'), Buffer.from(webhookSignature, 'utf8'))) {
                return respondOrderError(res, 400, 'WEBHOOK_SIGNATURE_INVALID', 'Invalid webhook signature');
            }
        } catch {
            return respondOrderError(res, 400, 'WEBHOOK_SIGNATURE_INVALID', 'Invalid webhook signature');
        }

        const webhookBody = JSON.parse(rawBody.toString('utf8'));
        const { event, payload } = webhookBody;

        switch (event) {
            case 'payment.captured': {
                const payment = payload.payment.entity;
                const order = await Order.findOne({
                    $or: [
                        { 'paymentInfo.razorpayOrderId': payment.order_id },
                        { 'paymentInfo.sessions.razorpayOrderId': payment.order_id }
                    ]
                });
                if (!order || order.paymentStatus === 'paid') {
                    break;
                }

                order.paymentInfo = order.paymentInfo || {};
                order.paymentInfo.capturedPaymentIds = order.paymentInfo.capturedPaymentIds || [];
                if (order.paymentInfo.capturedPaymentIds.includes(payment.id)) {
                    break;
                }

                const rpOrder = await razorpay.orders.fetch(payment.order_id);
                const expectedPaise = Number(rpOrder.amount);
                const paidPaise = Number(payment.amount);
                if (
                    !Number.isFinite(expectedPaise) ||
                    !Number.isFinite(paidPaise) ||
                    paidPaise !== expectedPaise
                ) {
                    break;
                }
                if (rpOrder?.notes?.orderId && rpOrder.notes.orderId !== order.orderId) {
                    break;
                }

                const paidInr = roundMoney2(paidPaise / 100);
                order.amountPaidInr = roundMoney2((order.amountPaidInr || 0) + paidInr);
                order.balanceDueInr = roundMoney2(order.totalAmount - order.amountPaidInr);
                if (order.balanceDueInr <= 0.005) {
                    order.paymentStatus = 'paid';
                    order.orderStatus = 'confirmed';
                    order.balanceDueInr = 0;
                } else {
                    order.paymentStatus = 'partially_paid';
                    order.orderStatus = 'confirmed';
                }
                order.paymentInfo.razorpayPaymentId = payment.id;
                order.paymentInfo.status = 'success';
                order.paymentInfo.paidAt = new Date(payment.created_at * 1000 || Date.now());
                order.paymentInfo.amountPaise = paidPaise;
                order.paymentInfo.capturedPaymentIds.push(payment.id);
                if (Array.isArray(order.paymentInfo.sessions)) {
                    const s = order.paymentInfo.sessions.find((x) => x.razorpayOrderId === payment.order_id);
                    if (s) {
                        s.status = 'paid';
                        s.razorpayPaymentId = payment.id;
                        s.paidAt = new Date();
                    }
                }
                order.markModified('paymentInfo');
                await order.save();

                if (order.paymentStatus === 'paid' && !order.shipmentInfo?.trackingNumber) {
                    ShiprocketService.createShipment(order).catch((err) => {
                        console.error('Shipment creation failed:', err);
                    });
                }
                break;
            }

            case 'payment.failed': {
                const failedPayment = payload.payment.entity;
                const failedOrder = await Order.findOne({
                    $or: [
                        { 'paymentInfo.razorpayOrderId': failedPayment.order_id },
                        { 'paymentInfo.sessions.razorpayOrderId': failedPayment.order_id }
                    ]
                });
                if (failedOrder && failedOrder.paymentStatus === 'pending') {
                    failedOrder.paymentStatus = 'failed';
                    failedOrder.orderStatus = 'payment_failed';
                    failedOrder.paymentInfo = failedOrder.paymentInfo || {};
                    failedOrder.paymentInfo.status = 'failed';
                    failedOrder.paymentInfo.failureReason =
                        failedPayment.error_description || failedPayment.error_code || 'Payment failed';
                    failedOrder.paymentInfo.failureCode = failedPayment.error_code || '';
                    failedOrder.markModified('paymentInfo');
                    await failedOrder.save();

                    await releaseReservedInventoryForOrder(failedOrder);
                }
                break;
            }

            case 'refund.created':
            case 'refund.processed': {
                const refund = payload.refund.entity;
                const refundOrder = await Order.findOne({ 'paymentInfo.razorpayPaymentId': refund.payment_id });
                await applyRefundEntryToOrder(refundOrder, refund);
                break;
            }

            default:
                break;
        }

        return res.json({ success: true });
    } catch (error) {
        console.error('Webhook error:', error);
        return respondOrderError(res, 500, 'WEBHOOK_PROCESSING_FAILED', 'Webhook processing failed');
    }
};

// ========== PAY REMAINING BALANCE (after advance) ==========
exports.payOrderBalance = async (req, res) => {
    try {
        const { orderId } = req.params;
        const order = await Order.findOne({ orderId, userId: req.userId });
        if (!order) {
            return respondOrderError(res, 404, 'ORDER_NOT_FOUND', 'Order not found');
        }
        if (order.paymentStatus === 'paid') {
            return respondOrderError(res, 400, 'ORDER_ALREADY_PAID', 'Order is already fully paid');
        }
        const due = roundMoney2(order.balanceDueInr || order.totalAmount - (order.amountPaidInr || 0));
        if (!Number.isFinite(due) || due <= 0.01) {
            return respondOrderError(res, 400, 'NO_BALANCE_DUE', 'No balance due on this order');
        }

        const amountPaise = Math.round(due * 100);
        if (!String(process.env.RAZORPAY_KEY_ID || '').trim() || !String(process.env.RAZORPAY_KEY_SECRET || '').trim()) {
            return respondOrderError(res, 503, 'PAYMENT_GATEWAY_UNAVAILABLE', 'Razorpay is not configured');
        }

        const rz = await razorpay.orders.create({
            amount: amountPaise,
            currency: 'INR',
            receipt: String(order.orderId).slice(0, 40),
            payment_capture: 1,
            notes: {
                orderId: order.orderId,
                userId: String(req.userId),
                type: 'balance'
            }
        });

        order.paymentInfo = order.paymentInfo || {};
        order.paymentInfo.razorpayOrderId = rz.id;
        order.paymentInfo.sessions = order.paymentInfo.sessions || [];
        order.paymentInfo.sessions.push({
            razorpayOrderId: rz.id,
            expectedAmountPaise: Number(rz.amount),
            status: 'created'
        });
        order.markModified('paymentInfo');
        await order.save();

        return res.json({
            success: true,
            message: 'Pay remaining balance with Razorpay',
            razorpayOrder: { id: rz.id, amount: rz.amount, currency: rz.currency },
            balanceDueInr: due,
            orderId: order.orderId
        });
    } catch (error) {
        console.error('payOrderBalance:', error);
        return respondOrderError(res, 500, 'PAY_BALANCE_INIT_FAILED', 'Failed to start balance payment');
    }
};

/**
 * Start (or retry) Razorpay Checkout for an unpaid online order still in checkout state.
 * Frontend: POST → open Checkout with razorpayKeyId + razorpayOrder.id + amount; on success call verify-payment.
 */
exports.initiatePendingOrderPayment = async (req, res) => {
    try {
        const { orderId } = req.params;
        const order = await Order.findOne({ orderId, userId: req.userId });
        if (!order) {
            return res.status(404).json({
                success: false,
                code: 'ORDER_NOT_FOUND',
                message: 'Order not found'
            });
        }

        if (order.paymentInfo?.method !== 'online') {
            return res.status(400).json({
                success: false,
                code: 'PAYMENT_NOT_ONLINE',
                message: 'This order is not an online payment checkout'
            });
        }

        if (order.orderStatus !== 'pending') {
            return res.status(409).json({
                success: false,
                code: 'INVALID_ORDER_STATE',
                message: `Order is ${order.orderStatus}. Retry payment is only for orders awaiting first payment.`
            });
        }

        if (order.paymentStatus !== 'pending') {
            return res.status(409).json({
                success: false,
                code: 'INVALID_PAYMENT_STATE',
                message: 'Payment already progressed. Use pay-balance if you owe a remaining amount.'
            });
        }

        if (Number(order.amountPaidInr || 0) > 0.01) {
            return res.status(409).json({
                success: false,
                code: 'USE_PAY_BALANCE_ENDPOINT',
                message: 'Partial payment already recorded. Use the pay-balance endpoint for the remainder.',
                payBalancePath: `/api/orders/items/${encodeURIComponent(orderId)}/pay-balance`
            });
        }

        if (paymentHoldExpiryService.isOrderPaymentHoldExpired(order)) {
            return res.status(410).json({
                success: false,
                code: 'PAYMENT_WINDOW_EXPIRED',
                message: 'The payment window for this order has expired. Place a new order.'
            });
        }

        const keyId = String(process.env.RAZORPAY_KEY_ID || '').trim();
        const keySecret = String(process.env.RAZORPAY_KEY_SECRET || '').trim();
        if (!keyId || !keySecret) {
            return res.status(503).json({
                success: false,
                code: 'PAYMENT_GATEWAY_UNAVAILABLE',
                message: 'Payment provider is not configured'
            });
        }

        const amountPaise = Math.round(Number(order.paymentInfo?.amountPaise));
        const fullOrderPaise = Math.round(Number(order.paymentInfo?.fullOrderAmountPaise));
        if (!Number.isFinite(amountPaise) || amountPaise <= 0) {
            logger.error('initiatePendingOrderPayment: bad amountPaise', { orderId: order.orderId });
            return res.status(500).json({
                success: false,
                code: 'ORDER_PAYMENT_AMOUNT_INVALID',
                message: 'Order is missing a valid payable amount'
            });
        }
        if (
            order.paymentInfo?.splitMode === 'advance' &&
            Number.isFinite(fullOrderPaise) &&
            fullOrderPaise > 0 &&
            amountPaise > fullOrderPaise
        ) {
            return res.status(500).json({
                success: false,
                code: 'ORDER_PAYMENT_AMOUNT_INVALID',
                message: 'Stored advance amount is inconsistent with order total'
            });
        }

        let rz;
        try {
            rz = await razorpay.orders.create({
                amount: amountPaise,
                currency: 'INR',
                receipt: `${String(order.orderId).slice(0, 24)}-${Date.now().toString(36)}`.slice(0, 40),
                payment_capture: 1,
                notes: {
                    orderId: order.orderId,
                    userId: String(req.userId),
                    type: 'retry_checkout'
                }
            });
        } catch (rzErr) {
            const body = rzErr && (rzErr.error || rzErr);
            logger.error('initiatePendingOrderPayment: Razorpay rejected', {
                orderId: order.orderId,
                message: rzErr?.message,
                code: body?.code
            });
            return res.status(502).json({
                success: false,
                code: 'RAZORPAY_REJECTED',
                message: (body && (body.description || body.message)) || rzErr.message || 'Could not start payment',
                detail: body?.code || null
            });
        }

        order.paymentInfo = order.paymentInfo || {};
        order.paymentInfo.razorpayOrderId = rz.id;
        order.paymentInfo.amountPaise = Number(rz.amount);
        order.paymentInfo.status = 'created';
        order.paymentInfo.sessions = order.paymentInfo.sessions || [];
        order.paymentInfo.sessions.push({
            razorpayOrderId: rz.id,
            expectedAmountPaise: Number(rz.amount),
            status: 'created',
            initiatedAt: new Date()
        });
        order.markModified('paymentInfo');
        await order.save();

        return res.json({
            success: true,
            message: 'Complete payment in Razorpay Checkout',
            orderId: order.orderId,
            razorpayKeyId: keyId,
            razorpayOrder: {
                id: rz.id,
                amount: rz.amount,
                currency: rz.currency
            },
            paymentSplitMode: order.paymentInfo.splitMode || 'full',
            balanceDueInr: order.balanceDueInr || 0
        });
    } catch (error) {
        logger.error('initiatePendingOrderPayment', { message: error.message, stack: error.stack });
        return res.status(500).json({
            success: false,
            code: 'INTERNAL_ERROR',
            message: 'Could not start payment'
        });
    }
};

// ========== GET ORDER ==========
// controllers/order.controller.js

exports.getOrder = async (req, res) => {
    try {
        const { orderId } = req.params;
        
        const isOrderStaff = isOrderStaffRequest(req);

        let orderQuery = Order.findOne({ orderId: orderId })
            .populate('items.productId', 'name slug variants')
            .populate('address');

        if (isOrderStaff) {
            orderQuery = orderQuery.populate('userId', 'name email phone');
        }

        const order = await orderQuery;

        if (!order) {
            return respondOrderError(res, 404, 'ORDER_NOT_FOUND', 'Order not found');
        }

        if (!canViewOrderForRequest(req, order, isOrderStaff)) {
            return buildUnauthorizedOrderResponse(res);
        }

        const transformedOrder = order.toObject();

        transformedOrder.items = transformedOrder.items.map((item) => {
            const product = item.productId;
            const variant = product?.variants?.find((v) => String(v._id) === String(item.variantId));
            const firstImg = Array.isArray(variant?.images) ? variant.images[0] : null;
            const thumbnailUrl =
                typeof firstImg === 'string'
                    ? firstImg
                    : firstImg && typeof firstImg === 'object'
                      ? firstImg.url || firstImg.secure_url
                      : null;

            return {
                ...item,
                sku: variant?.sku || null,
                thumbnailUrl,
                lineTotal: Number(item.priceSnapshot?.total) || 0,
                productId: {
                    _id: product?._id,
                    name: product?.name,
                    slug: product?.slug,
                    images: variant?.images || []
                }
            };
        });

        if (isOrderStaff && transformedOrder.userId && typeof transformedOrder.userId === 'object') {
            transformedOrder.customer = {
                name: transformedOrder.userId.name || null,
                email: transformedOrder.userId.email || null,
                phone: transformedOrder.userId.phone || null
            };
            transformedOrder.userId = transformedOrder.userId._id;
        }

        return res.json({
            success: true,
            order: transformedOrder
        });

    } catch (error) {
        console.error('Get order error:', error);
        return respondOrderError(res, 500, 'ORDER_FETCH_FAILED', 'Error fetching order', {
            error: error.message
        });
    }
};
// ========== GET USER ORDERS ==========
exports.getUserOrders = async (req, res) => {
    try {
        const orders = await Order.find({ userId: req.userId })
            .sort({ createdAt: -1 })
            .select(
                'orderId totalAmount orderStatus paymentStatus createdAt deliveryCharges tax subtotal paymentHoldExpiresAt balanceDueInr amountPaidInr paymentInfo'
            );

        return res.json({
            success: true,
            count: orders.length,
            orders: orders
        });

    } catch (error) {
        console.error('Get user orders error:', error);
        return respondOrderError(res, 500, 'USER_ORDERS_FETCH_FAILED', 'Error fetching orders', {
            error: error.message
        });
    }
};

// ========== CANCEL ORDER ==========
exports.cancelOrder = async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const { orderId } = req.params;
        const userId = req.userId;

        const order = await Order.findOne({ orderId: orderId, userId: userId }).session(session);
        if (!order) {
            await session.abortTransaction();
            session.endSession();
            return respondOrderError(res, 404, 'ORDER_NOT_FOUND', 'Order not found');
        }

        const cancellableStatuses = ['pending', 'confirmed'];
        if (!cancellableStatuses.includes(order.orderStatus)) {
            await session.abortTransaction();
            session.endSession();
            return respondOrderError(res, 400, 'ORDER_CANCELLATION_NOT_ALLOWED', `Order cannot be cancelled in ${order.orderStatus} status`);
        }

        const wasPaid = order.paymentStatus === 'paid';
        const canInitiateRefund = wasPaid && Boolean(order.paymentInfo?.razorpayPaymentId);

        order.orderStatus = 'cancelled';
        order.paymentInfo = order.paymentInfo || {};
        order.paymentInfo.cancellationReason = 'user_cancelled';
        order.paymentInfo.cancelledAt = new Date();
        order.returnInfo = {
            ...(order.returnInfo || {}),
            status: canInitiateRefund ? 'refund_pending' : (wasPaid ? 'refund_unavailable' : 'not_required'),
            requestedAt: new Date(),
            refundAmount: canInitiateRefund ? order.totalAmount : (order.returnInfo?.refundAmount || 0)
        };
        order.markModified('paymentInfo');

        await order.save({ session });
        await releaseReservedInventoryForOrder(order, session);

        await session.commitTransaction();
        session.endSession();

        let refundWarning = null;
        if (canInitiateRefund) {
            try {
                const refund = await razorpay.payments.refund(order.paymentInfo.razorpayPaymentId, {
                    amount: Math.round(order.totalAmount * 100),
                    notes: {
                        orderId: order.orderId,
                        reason: 'Order cancelled by user'
                    }
                });

                order.paymentStatus = 'refunded';
                order.returnInfo = {
                    ...(order.returnInfo || {}),
                    refundAmount: order.totalAmount,
                    refundId: refund.id,
                    status: 'refunded',
                    approvedAt: new Date()
                };
                await order.save();
            } catch (refundError) {
                order.returnInfo = {
                    ...(order.returnInfo || {}),
                    status: 'refund_failed'
                };
                order.paymentInfo = {
                    ...(order.paymentInfo || {}),
                    refundFailureReason: refundError?.message || 'Refund API failed'
                };
                order.markModified('paymentInfo');
                await order.save();
                refundWarning = 'Order cancelled, but refund failed. Support team action required.';
                logger.error('Refund initiation failed after cancellation', {
                    orderId: order.orderId,
                    message: refundError?.message
                });
            }
        }

        return res.json({
            success: true,
            message: refundWarning || 'Order cancelled successfully',
            order: {
                orderId: order.orderId,
                orderStatus: order.orderStatus,
                paymentStatus: order.paymentStatus,
                refundStatus: order.returnInfo?.status || null
            }
        });

    } catch (error) {
        await abortTransactionSafely(session);
        session.endSession();
        console.error('Cancel order error:', error);
        return respondOrderError(res, 500, 'ORDER_CANCELLATION_FAILED', 'Error cancelling order');
    }
};

// ========== UPDATE ORDER STATUS (Admin) ==========
exports.updateOrderStatus = async (req, res) => {
    try {
        const { orderId } = req.params;
        const { status } = req.body;
        const allowedStatuses = new Set([
            'pending',
            'confirmed',
            'processing',
            'shipped',
            'out_for_delivery',
            'delivered',
            'cancelled',
            'payment_failed'
        ]);

        if (!isOrderStaffRequest(req)) {
            return respondOrderError(res, 403, 'ORDER_ADMIN_ACCESS_REQUIRED', 'Admin access required');
        }

        if (!status || typeof status !== 'string' || !allowedStatuses.has(status)) {
            return respondOrderError(
                res,
                400,
                'ORDER_STATUS_INVALID',
                'Invalid order status value'
            );
        }

        const order = await Order.findOne({ orderId: orderId });
        if (!order) {
            return respondOrderError(res, 404, 'ORDER_NOT_FOUND', 'Order not found');
        }

        order.orderStatus = status;
        
        if (status === 'shipped') {
            order.shipmentInfo = {
                ...order.shipmentInfo,
                shippedAt: new Date()
            };
        }
        
        if (status === 'delivered') {
            order.shipmentInfo = {
                ...order.shipmentInfo,
                deliveredAt: new Date()
            };
        }

        await order.save();

        return res.json({
            success: true,
            message: 'Order status updated successfully',
            order: {
                orderId: order.orderId,
                orderStatus: order.orderStatus
            }
        });

    } catch (error) {
        console.error('Update order status error:', error);
        return respondOrderError(res, 500, 'ORDER_STATUS_UPDATE_FAILED', 'Error updating order status', {
            error: error.message
        });
    }
};

// ========== GENERATE INVOICE ==========
exports.generateInvoice = async (req, res) => {
    try {
        const { orderId } = req.params;
        const order = await Order.findOne({ orderId: orderId })
            .populate('items.productId', 'name')
            .populate('address');

        if (!order) {
            return respondOrderError(res, 404, 'ORDER_NOT_FOUND', 'Order not found');
        }

        if (!canViewOrderForRequest(req, order, isOrderStaffRequest(req))) {
            return buildUnauthorizedOrderResponse(res);
        }

        const invoice = {
            invoiceNumber: `INV-${order.orderId}`,
            orderId: order.orderId,
            date: order.createdAt,
            customer: order.addressSnapshot,
            items: order.items.map(item => ({
                name: item.productId?.name || 'Product',
                quantity: item.quantity,
                price: item.priceSnapshot.sale || item.priceSnapshot.base,
                total: item.priceSnapshot.total
            })),
            subtotal: order.subtotal,
            deliveryCharges: order.deliveryCharges,
            tax: order.tax,
            total: order.totalAmount,
            paymentMethod: order.paymentInfo?.method,
            paymentStatus: order.paymentStatus,
            orderStatus: order.orderStatus
        };

        return res.json({
            success: true,
            invoice: invoice
        });

    } catch (error) {
        console.error('Generate invoice error:', error);
        return respondOrderError(res, 500, 'INVOICE_GENERATION_FAILED', 'Error generating invoice', {
            error: error.message
        });
    }
};

// ========== TRACK ORDER ==========
exports.trackOrder = async (req, res) => {
    try {
        const { orderId } = req.params;
        const order = await Order.findOne({ orderId: orderId });

        if (!order) {
            return respondOrderError(res, 404, 'ORDER_NOT_FOUND', 'Order not found');
        }

        if (!canViewOrderForRequest(req, order, isOrderStaffRequest(req))) {
            return buildUnauthorizedOrderResponse(res);
        }

        const timeline = {
            'pending': [
                { status: 'Order Placed', completed: true, timestamp: order.createdAt },
                { status: 'Payment Pending', completed: false, timestamp: null }
            ],
            'confirmed': [
                { status: 'Order Placed', completed: true, timestamp: order.createdAt },
                { status: 'Payment Confirmed', completed: true, timestamp: order.paymentInfo?.paidAt || order.updatedAt },
                { status: 'Processing', completed: false, timestamp: null }
            ],
            'shipped': [
                { status: 'Order Placed', completed: true, timestamp: order.createdAt },
                { status: 'Payment Confirmed', completed: true, timestamp: order.paymentInfo?.paidAt || order.updatedAt },
                { status: 'Shipped', completed: true, timestamp: order.shipmentInfo?.shippedAt },
                { status: 'Out for Delivery', completed: false, timestamp: null }
            ],
            'out_for_delivery': [
                { status: 'Order Placed', completed: true, timestamp: order.createdAt },
                { status: 'Payment Confirmed', completed: true, timestamp: order.paymentInfo?.paidAt || order.updatedAt },
                { status: 'Shipped', completed: true, timestamp: order.shipmentInfo?.shippedAt },
                { status: 'Out for Delivery', completed: true, timestamp: order.shipmentInfo?.outForDeliveryAt },
                { status: 'Delivered', completed: false, timestamp: null }
            ],
            'delivered': [
                { status: 'Order Placed', completed: true, timestamp: order.createdAt },
                { status: 'Payment Confirmed', completed: true, timestamp: order.paymentInfo?.paidAt || order.updatedAt },
                { status: 'Shipped', completed: true, timestamp: order.shipmentInfo?.shippedAt },
                { status: 'Out for Delivery', completed: true, timestamp: order.shipmentInfo?.outForDeliveryAt },
                { status: 'Delivered', completed: true, timestamp: order.shipmentInfo?.deliveredAt }
            ],
            'cancelled': [
                { status: 'Order Placed', completed: true, timestamp: order.createdAt },
                { status: 'Cancelled', completed: true, timestamp: order.updatedAt }
            ]
        };

        const tracking = {
            orderId: order.orderId,
            currentStatus: order.orderStatus,
            trackingNumber: order.shipmentInfo?.trackingNumber || null,
            courier: order.shipmentInfo?.courier || null,
            timeline: timeline[order.orderStatus] || timeline.pending,
            estimatedDelivery: order.shipmentInfo?.estimatedDelivery || null
        };

        return res.json({
            success: true,
            tracking: tracking
        });

    } catch (error) {
        console.error('Track order error:', error);
        return respondOrderError(res, 500, 'ORDER_TRACK_FAILED', 'Error tracking order', {
            error: error.message
        });
    }
};

// ========== ADMIN: REFUND (full or partial, server-validated) ==========
exports.refundOrderPayment = async (req, res) => {
    try {
        const { orderId } = req.params;
        const { amount } = req.body || {};

        const order = await Order.findOne({ orderId });
        if (!order) {
            return respondOrderError(res, 404, 'ORDER_NOT_FOUND', 'Order not found');
        }

        if (!['paid', 'partially_refunded'].includes(order.paymentStatus)) {
            return respondOrderError(res, 400, 'ORDER_NOT_REFUNDABLE', 'Order is not in a refundable payment state');
        }

        if (!order.paymentInfo?.razorpayPaymentId) {
            return respondOrderError(res, 400, 'RAZORPAY_PAYMENT_MISSING', 'No Razorpay payment on this order');
        }

        const alreadyRefundedInr = roundMoney2(
            (order.refundHistory || []).reduce((s, r) => s + (Number(r.amountInr) || 0), 0)
        );
        const remainingInr = roundMoney2(order.totalAmount - alreadyRefundedInr);

        if (remainingInr <= 0) {
            return respondOrderError(res, 400, 'REFUND_NOTHING_PENDING', 'Nothing left to refund');
        }

        const requestedInr =
            amount !== undefined && amount !== null && String(amount).trim() !== ''
                ? roundMoney2(Number(amount))
                : remainingInr;

        if (!Number.isFinite(requestedInr) || requestedInr <= 0) {
            return respondOrderError(res, 400, 'REFUND_AMOUNT_INVALID', 'Invalid refund amount');
        }

        if (requestedInr > remainingInr) {
            return respondOrderError(res, 400, 'REFUND_AMOUNT_EXCEEDS_REMAINING', `Refund cannot exceed remaining ${remainingInr} INR for this order`);
        }

        const paise = Math.round(requestedInr * 100);
        const refund = await razorpay.payments.refund(order.paymentInfo.razorpayPaymentId, {
            amount: paise,
            speed: 'normal',
            notes: {
                orderId: order.orderId,
                reason: 'admin_refund'
            }
        });

        await applyRefundEntryToOrder(order, refund);

        return res.json({
            success: true,
            message: 'Refund initiated successfully',
            refund: {
                id: refund.id,
                amountInr: requestedInr,
                amountPaise: paise,
                status: refund.status
            },
            order: {
                orderId: order.orderId,
                paymentStatus: order.paymentStatus
            }
        });
    } catch (error) {
        console.error('Refund order error:', error);
        return respondOrderError(
            res,
            500,
            'REFUND_INIT_FAILED',
            error.error?.description || error.message || 'Refund failed'
        );
    }
};