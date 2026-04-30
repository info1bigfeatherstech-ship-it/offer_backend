const Address = require('../models/Address');
const Cart = require('../models/cart');
const CheckoutQuote = require('../models/CheckoutQuote');
const {
  computeCheckoutTotals,
  roundMoney2,
  cartFingerprintFromItems,
  evaluateCartForCheckout,
  resolveCouponDiscount,
  calculateTax
} = require('../services/checkoutComputation.service');
const {
  normalizePaymentMethod,
  normalizePaymentPlan,
  createInvalidPaymentMethodError,
  createQuoteExpiredError,
  createQuoteStaleError,
  sendCheckoutFlowError,
  buildRequestLogContext
} = require('../utils/checkoutFlow');
const logger = require('../utils/logger');

const QUOTE_TTL_MS = 15 * 60 * 1000;

const normalizePin = (p) => String(p || '').replace(/\D/g, '').slice(0, 6);

function allowDemoMockShipping(req) {
  if (req.body?.demoMockShipping !== true) return false;
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_CHECKOUT_DEMO_MOCK !== 'true') {
    return false;
  }
  return true;
}

async function buildFinalTotals({ cartDoc, pin, finalUserType, storefront, couponCode, paymentMethodHint, req }) {
  if (allowDemoMockShipping(req)) {
    const evaluated = await evaluateCartForCheckout(cartDoc, finalUserType, null, storefront);
    const { discount, appliedCouponCode } = await resolveCouponDiscount(
      couponCode,
      evaluated.subtotal,
      finalUserType,
      null,
      { consumeUsage: false }
    );
    const deliveryCharges = roundMoney2(35 + Math.floor(Math.random() * 56));
    const tax = calculateTax(evaluated.lines);
    const totalAmount = roundMoney2(evaluated.subtotal + deliveryCharges + tax - discount);
    return {
      ...evaluated,
      discount,
      appliedCouponCode,
      deliveryCharges,
      tax,
      totalAmount,
      deliveryMeta: {
        estimatedDays: String(2 + Math.floor(Math.random() * 3)) + '-5',
        courierName: 'Demo courier (Shiprocket off)',
        isDeliverable: true,
        codAvailable: true,
        mock: true
      }
    };
  }

  const assumeCod = String(paymentMethodHint || '').toLowerCase() === 'cod';
  let last = await computeCheckoutTotals({
    cart: cartDoc,
    postalCode: pin,
    finalUserType,
    storefront,
    couponCode,
    session: null,
    consumeCoupon: false,
    codAmountForShiprocket: 0
  });

  // COD: Shiprocket quote can depend on declared COD amount — two passes converge fee/totals (same math as before).
  if (assumeCod) {
    for (let i = 0; i < 2; i++) {
      const codVal = roundMoney2(last.subtotal + last.tax - last.discount + last.deliveryCharges);
      last = await computeCheckoutTotals({
        cart: cartDoc,
        postalCode: pin,
        finalUserType,
        storefront,
        couponCode,
        session: null,
        consumeCoupon: false,
        codAmountForShiprocket: codVal
      });
    }
  }

  return last;
}

/**
 * POST /api/checkout/quote
 */
exports.quoteCheckout = async (req, res) => {
  try {
    const userId = req.userId;
    const finalUserType = req.userType === 'wholesaler' ? 'wholesaler' : 'normal';
    const storefront = req.storefront || 'ecomm';
    const { addressId, couponCode, paymentMethodHint } = req.body || {};

    if (paymentMethodHint !== undefined && paymentMethodHint !== null && paymentMethodHint !== '') {
      const normalizedPaymentMethodHint = normalizePaymentMethod(paymentMethodHint);
      if (!normalizedPaymentMethodHint) {
        throw createInvalidPaymentMethodError();
      }
    }

    if (!addressId) {
      return res.status(400).json({ success: false, message: 'addressId is required' });
    }

    if (req.body?.demoMockShipping === true && !allowDemoMockShipping(req)) {
      return res.status(400).json({
        success: false,
        message: 'demoMockShipping is not enabled in this environment'
      });
    }

    const address = await Address.findById(addressId).lean();
    if (!address || String(address.userId) !== String(userId)) {
      return res.status(404).json({ success: false, message: 'Address not found' });
    }

    const pin = normalizePin(address.postalCode);
    if (pin.length !== 6) {
      return res.status(400).json({ success: false, message: 'Address must have a valid 6-digit postal code' });
    }

    const cartDoc = await Cart.findOne({ userId });
    if (!cartDoc?.items?.length) {
      return res.status(400).json({ success: false, message: 'cart is empty' });
    }

    const finalTotals = await buildFinalTotals({
      cartDoc,
      pin,
      finalUserType,
      storefront,
      couponCode,
      paymentMethodHint,
      req
    });

    const fp = cartFingerprintFromItems(cartDoc.items);
    const quoteExpiresAt = new Date(Date.now() + QUOTE_TTL_MS);
    const couponCodeUpper = couponCode ? String(couponCode).toUpperCase().trim() : '';

    await CheckoutQuote.updateMany(
      {
        userId,
        status: { $in: ['active', 'confirmed'] }
      },
      {
        $set: {
          status: 'expired',
          lastValidatedAt: new Date()
        }
      }
    );

    cartDoc.deliverySnapshot = {
      addressId,
      postalCode: pin,
      quotedAt: new Date(),
      cartFingerprint: fp,
      isDeliverable: true,
      deliveryCharges: finalTotals.deliveryCharges,
      estimatedDays: finalTotals.deliveryMeta?.estimatedDays,
      courierName: finalTotals.deliveryMeta?.courierName,
      weightKg: finalTotals.totalWeight,
      dims: finalTotals.dims,
      couponCodeUpper,
      ttlMs: QUOTE_TTL_MS,
      mockShipping: Boolean(allowDemoMockShipping(req))
    };
    await cartDoc.save();

    const quote = await CheckoutQuote.create({
      userId,
      addressId,
      postalCode: pin,
      couponCodeUpper,
      cartFingerprint: fp,
      userType: finalUserType,
      itemCount: cartDoc.items.length,
      itemsSubtotal: finalTotals.subtotal,
      promotionDiscount: finalTotals.discount,
      deliveryCharges: finalTotals.deliveryCharges,
      taxes: finalTotals.tax,
      amountPayable: finalTotals.totalAmount,
      shippingMeta: {
        isDeliverable: true,
        estimatedDays: finalTotals.deliveryMeta?.estimatedDays || null,
        courierName: finalTotals.deliveryMeta?.courierName || null,
        courierCompanyId: finalTotals.deliveryMeta?.courierCompanyId || null,
        codAvailable: finalTotals.deliveryMeta?.codAvailable !== false,
        message: 'Delivery available',
        mock: Boolean(finalTotals.deliveryMeta?.mock)
      },
      totalWeightKg: finalTotals.totalWeight,
      dims: finalTotals.dims,
      status: 'active',
      quoteExpiresAt
    });

    logger.info('Checkout quote created', buildRequestLogContext(req, {
      quoteId: String(quote._id),
      cartFingerprint: fp,
      paymentMethodHint: paymentMethodHint || null
    }));

    const eta =
      finalTotals.deliveryMeta?.estimatedDays != null
        ? `Estimated delivery in ${finalTotals.deliveryMeta.estimatedDays} business days`
        : 'Delivery timeline will be confirmed after dispatch';

    return res.json({
      success: true,
      quoteId: quote._id,
      isDeliverable: true,
      codAvailable: quote.shippingMeta.codAvailable,
      deliveryEstimate: eta,
      courierName: finalTotals.deliveryMeta?.courierName || null,
      pincode: pin,
      itemCount: cartDoc.items.length,
      itemsSubtotal: finalTotals.subtotal,
      promotionDiscount: finalTotals.discount,
      deliveryCharges: finalTotals.deliveryCharges,
      taxes: finalTotals.tax,
      amountPayable: finalTotals.totalAmount,
      includesShippingAndHandling: true,
      couponApplied: finalTotals.appliedCouponCode,
      quoteExpiresAt: quoteExpiresAt.toISOString(),
      cartFingerprint: fp,
      demoMockShipping: Boolean(allowDemoMockShipping(req))
    });
  } catch (err) {
    if (err.statusCode) {
      return sendCheckoutFlowError(res, err, 'Failed to build checkout quote');
    }
    logger.error('quoteCheckout failed', buildRequestLogContext(req, {
      error: err.message,
      stack: err.stack
    }));
    return res.status(500).json({ success: false, message: 'Failed to build checkout quote' });
  }
};

/**
 * POST /api/checkout/confirm
 * Re-validates quote against latest cart/coupon/shipping before creating payment intent/order.
 */
exports.confirmCheckout = async (req, res) => {
  try {
    const userId = req.userId;
    const finalUserType = req.userType === 'wholesaler' ? 'wholesaler' : 'normal';
    const storefront = req.storefront || 'ecomm';
    const { quoteId, paymentMethod, paymentPlan } = req.body || {};

    if (!quoteId) {
      return res.status(400).json({ success: false, message: 'quoteId is required' });
    }

    const normalizedPaymentMethod = normalizePaymentMethod(paymentMethod);
    if (!normalizedPaymentMethod) {
      throw createInvalidPaymentMethodError();
    }
    const normalizedPaymentPlan = normalizePaymentPlan(paymentPlan);

    const quote = await CheckoutQuote.findOne({ _id: quoteId, userId, status: 'active' });
    if (!quote) {
      return res.status(404).json({ success: false, message: 'Quote not found or inactive' });
    }

    if (quote.quoteExpiresAt.getTime() <= Date.now()) {
      quote.status = 'expired';
      await quote.save();
      throw createQuoteExpiredError();
    }

    const address = await Address.findById(quote.addressId).lean();
    if (!address || String(address.userId) !== String(userId)) {
      return res.status(400).json({ success: false, message: 'Address is no longer valid for this quote' });
    }

    const pin = normalizePin(address.postalCode);
    if (pin.length !== 6 || pin !== quote.postalCode) {
      return res.status(400).json({ success: false, message: 'Address pincode changed. Regenerate quote.' });
    }

    const cartDoc = await Cart.findOne({ userId });
    if (!cartDoc?.items?.length) {
      return res.status(400).json({ success: false, message: 'Cart is empty. Regenerate quote.' });
    }

    const fp = cartFingerprintFromItems(cartDoc.items);
    if (fp !== quote.cartFingerprint) {
      throw createQuoteStaleError('cart_changed', {
        message: 'Cart changed. Please refresh quote before proceeding.'
      });
    }

    const couponCode = quote.couponCodeUpper || null;
    const recomputed = await buildFinalTotals({
      cartDoc,
      pin,
      finalUserType,
      storefront,
      couponCode,
      paymentMethodHint: normalizedPaymentMethod === 'cod' ? 'cod' : 'online',
      req: { body: { demoMockShipping: Boolean(quote.shippingMeta?.mock) } }
    });

    if (normalizedPaymentMethod === 'cod' && recomputed.deliveryMeta?.codAvailable === false) {
      return res.status(400).json({
        success: false,
        code: 'COD_NOT_AVAILABLE',
        message: 'COD is not available for this pincode and cart combination.'
      });
    }

    const mismatch =
      roundMoney2(quote.itemsSubtotal) !== roundMoney2(recomputed.subtotal) ||
      roundMoney2(quote.promotionDiscount) !== roundMoney2(recomputed.discount) ||
      roundMoney2(quote.deliveryCharges) !== roundMoney2(recomputed.deliveryCharges) ||
      roundMoney2(quote.taxes) !== roundMoney2(recomputed.tax) ||
      roundMoney2(quote.amountPayable) !== roundMoney2(recomputed.totalAmount);

    if (mismatch) {
      throw createQuoteStaleError('pricing_changed', {
        message: 'Pricing changed since quote creation. Please refresh quote before proceeding.',
        details: {
          latest: {
            itemsSubtotal: recomputed.subtotal,
            promotionDiscount: recomputed.discount,
            deliveryCharges: recomputed.deliveryCharges,
            taxes: recomputed.tax,
            amountPayable: recomputed.totalAmount,
            codAvailable: recomputed.deliveryMeta?.codAvailable !== false
          }
        }
      });
    }

    quote.lastValidatedAt = new Date();
    quote.status = 'confirmed';
    quote.confirmedAt = new Date();
    await quote.save();

    logger.info('Checkout quote confirmed', buildRequestLogContext(req, {
      quoteId: String(quote._id),
      paymentMethod: normalizedPaymentMethod,
      paymentPlan: normalizedPaymentPlan
    }));

    return res.json({
      success: true,
      quoteId: quote._id,
      validated: true,
      paymentMethod: normalizedPaymentMethod,
      paymentPlan: normalizedPaymentPlan,
      codAvailable: recomputed.deliveryMeta?.codAvailable !== false,
      totals: {
        itemCount: cartDoc.items.length,
        itemsSubtotal: recomputed.subtotal,
        promotionDiscount: recomputed.discount,
        deliveryCharges: recomputed.deliveryCharges,
        taxes: recomputed.tax,
        amountPayable: recomputed.totalAmount
      },
      next: {
        createOrderEndpoint: '/api/orders/items',
        payload: {
          addressId: String(quote.addressId),
          paymentMethod: normalizedPaymentMethod === 'cod' ? 'cod' : 'online',
          onlinePaymentMode: normalizedPaymentPlan,
          couponCode: quote.couponCodeUpper || undefined,
          quoteId: String(quote._id)
        }
      }
    });
  } catch (err) {
    if (err.statusCode) {
      return sendCheckoutFlowError(res, err, 'Failed to confirm checkout quote');
    }
    logger.error('confirmCheckout failed', buildRequestLogContext(req, {
      error: err.message,
      stack: err.stack
    }));
    return res.status(500).json({ success: false, message: 'Failed to confirm checkout quote' });
  }
};
