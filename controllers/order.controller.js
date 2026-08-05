// controllers/order.controller.js
const Order = require('../models/Order');
const Address = require('../models/Address');
const CheckoutQuote = require('../models/CheckoutQuote');
const Product = require('../models/Product');
const Coupon = require('../models/Coupon');
const OrderIdempotencyKey = require('../models/OrderIdempotencyKey');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const mongoose = require('mongoose');
const ShiprocketService = require('../utils/shiprocket');
const ShipmozoService = require('../utils/shipmozo');
const shippingProviderSettingsService = require('../services/shippingProviderSettings.service');
const {
    SHIPPING_PROVIDERS,
    resolveOrderShippingProvider,
    isShipmozoOrder
} = require('../constants/shippingProviders');
const logger = require('../utils/logger');
const { cloudinary } = require('../config/cloudinary.config');
const {
    computeCheckoutTotals,
    cartFingerprintFromItems,
    roundMoney2
} = require('../services/checkoutComputation.service');
const {
    reserveCheckoutStock,
    releaseOrderStockHold,
    releaseInventoryHoldByOrderId,
    commitOrderStockHold,
    rereserveOrderStockHold,
    attachProductCodesToOrderItems
} = require('../services/orderStockBridge.service');
const { mergeOrderLineItemsIntoUserCart } = require('../services/restoreCartFromOrder.service');
const { findCartForStorefront } = require('../services/cartStorefront.service');
const { addressBelongsToStorefront } = require('../utils/customerStorefrontScope');
const paymentHoldExpiryService = require('../services/paymentHoldExpiry.service');
const checkoutSettingsService = require('../services/checkoutSettings.service');
const { buildGstInvoiceViewModel } = require('../utils/gstInvoice');
const {
    buildShippingWeightSnapshotFromCheckoutLines,
    buildShippingWeightSnapshotFromOrderItems,
    enrichShippingWeightSnapshotDims
} = require('../utils/shippingWeightSnapshot');
const {
    isAdvanceBalanceCodCheckout,
    assertStorePolicyAllowsCheckout
} = require('../utils/checkoutPaymentPolicy');
const { generateOrderId } = require('../utils/orderId');
const { mergeReturnInfo } = require('../services/rtoRefund.service');
const {
    mergeAdminOrderFilter
} = require('../utils/adminOrderScope');
const {
    isCustomerProductReturnRequest,
    buildAdminProductReturnRequestMatch
} = require('../utils/productReturnRequest');
const {
    normalizePaymentMethod,
    normalizePaymentPlan,
    normalizeBalanceCollection,
    parseQuoteLockedAdvancePercent,
    resolveDefaultAdvancePercent,
    resolveAdvancePaymentSelectionWithPolicy,
    normalizeIdempotencyKey,
    createInvalidPaymentMethodError,
    createQuoteExpiredError,
    createQuoteStaleError,
    createCheckoutFlowError,
    sendCheckoutFlowError,
    isOrderStaffRequest,
    buildRequestLogContext
} = require('../utils/checkoutFlow');
const { evaluateOrderPaymentForShiprocketFulfillment } = require('../utils/orderFulfillmentPaymentGate');
const { isLegacyAutoFulfillOnCheckout } = require('../constants/orderFulfillmentAutomation');
const {
    recoverOrderStatusAfterSuccessfulCapture,
    recordOnlinePaymentAttemptFailure,
    isMoneyCapturedPaymentStatus
} = require('../utils/orderPaymentState');

const normalizeDecisionCode = (errorLike, fallback) =>
    String(errorLike?.code || fallback || 'ORDER_FLOW_ERROR').trim().toUpperCase();

// Initialize Razorpay (trim — stray spaces/newlines in .env break auth)
const razorpay = new Razorpay({
    key_id: String(process.env.RAZORPAY_KEY_ID || '').trim(),
    key_secret: String(process.env.RAZORPAY_KEY_SECRET || '').trim()
});

const RETURN_REASON_TYPES = new Set(['damaged', 'wrong_item']);
const RETURN_REQUEST_WINDOW_DAYS = (() => {
    const raw = String(process.env.RETURN_REQUEST_WINDOW_DAYS || '').trim();
    if (!raw) return null; // disabled unless explicitly configured
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        logger.warn('Invalid RETURN_REQUEST_WINDOW_DAYS. Return window check disabled.', { value: raw });
        return null;
    }
    return Math.floor(parsed);
})();

/** Unpaid-online orders receive `paymentHoldExpiresAt` at creation; clears once Razorpay capture is persisted so APIs/UI cannot show a stale deadline. */
function clearOnlinePaymentHoldAfterSuccessfulCapture(order) {
    if (!order?.paymentHoldExpiresAt) return false;
    if (String(order.paymentInfo?.method || '').trim().toLowerCase() !== 'online') return false;
    order.paymentHoldExpiresAt = null;
    if (typeof order.markModified === 'function') {
        order.markModified('paymentHoldExpiresAt');
    }
    return true;
}

/**
 * After money is captured: clear hold, heal payment_failed/cancelled mismatch, optionally re-reserve stock
 * if an older failed webhook had released inventory.
 * @returns {Promise<{ dirty: boolean, recovery: object|null }>}
 */
async function applySuccessfulOnlineCaptureSideEffects(order, trigger) {
    let dirty = clearOnlinePaymentHoldAfterSuccessfulCapture(order);
    const recovery = recoverOrderStatusAfterSuccessfulCapture(order, { trigger });
    if (recovery.changed) {
        dirty = true;
        logger.info('[paymentState] Recovered orderStatus after capture', {
            orderId: order.orderId,
            trigger,
            from: recovery.previousOrderStatus,
            to: recovery.nextOrderStatus,
            paymentStatus: order.paymentStatus
        });

        if (recovery.previousOrderStatus === 'payment_failed') {
            try {
                const inv = await rereserveOrderStockHold(order);
                order.paymentInfo = order.paymentInfo || {};
                order.paymentInfo.inventoryReReserve = {
                    at: new Date(),
                    ok: Boolean(inv.ok),
                    source: inv.source || null,
                    shortages: inv.summary?.shortages || [],
                    code: inv.code || null
                };
                if (typeof order.markModified === 'function') {
                    order.markModified('paymentInfo');
                }
                dirty = true;
                if (!inv.ok) {
                    logger.error('[paymentState] Inventory shortage while recovering paid order', {
                        orderId: order.orderId,
                        result: inv
                    });
                }
            } catch (invErr) {
                logger.error('[paymentState] Inventory re-reserve failed after payment recovery', {
                    orderId: order.orderId,
                    message: invErr?.message || String(invErr)
                });
            }
        }
    }

    // First successful money capture → commit inventory hold (idempotent).
    try {
        const commitRes = await commitOrderStockHold(order);
        if (commitRes && commitRes.ok && !commitRes.skipped) {
            dirty = true;
        } else if (commitRes && !commitRes.ok && !commitRes.skipped) {
            logger.error('[paymentState] Inventory commit failed after capture', {
                orderId: order.orderId,
                trigger,
                result: commitRes
            });
        }
    } catch (commitErr) {
        logger.error('[paymentState] Inventory commit threw after capture', {
            orderId: order.orderId,
            trigger,
            message: commitErr?.message || String(commitErr)
        });
    }

    return { dirty, recovery: recovery.changed ? recovery : null };
}

function normalizeReturnReasonType(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!RETURN_REASON_TYPES.has(normalized)) return null;
    return normalized;
}

function normalizeReturnReasonMessage(value) {
    const msg = String(value || '').trim();
    if (!msg) return null;
    return msg.slice(0, 500);
}

function evaluateReturnRequestWindow(order) {
    if (!RETURN_REQUEST_WINDOW_DAYS) {
        return { enabled: false, expired: false };
    }
    const deliveredAtRaw = order?.shipmentInfo?.deliveredAt || null;
    if (!deliveredAtRaw) {
        // Preserve existing behavior for legacy orders with missing delivered timestamp.
        logger.warn('Delivered order missing deliveredAt; skipping return window validation', {
            orderId: order?.orderId
        });
        return { enabled: true, skipped: true, expired: false };
    }
    const deliveredAt = new Date(deliveredAtRaw);
    if (Number.isNaN(deliveredAt.getTime())) {
        logger.warn('Invalid deliveredAt; skipping return window validation', {
            orderId: order?.orderId,
            deliveredAtRaw
        });
        return { enabled: true, skipped: true, expired: false };
    }
    const deadlineAt = new Date(deliveredAt.getTime() + RETURN_REQUEST_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const now = new Date();
    const expired = now > deadlineAt;
    return {
        enabled: true,
        skipped: false,
        expired,
        days: RETURN_REQUEST_WINDOW_DAYS,
        deliveredAt,
        deadlineAt
    };
}

function mapReturnCarrierStatus(rawStatus) {
    const status = String(rawStatus || '').trim().toLowerCase();
    if (!status) return null;
    if (status.includes('cancel')) return 'reverse_cancelled';
    if (status.includes('deliver') || status.includes('received')) return 'received';
    if (status.includes('out for pickup') || status.includes('pickup')) return 'pickup_in_progress';
    if (status.includes('in transit') || status.includes('transit')) return 'in_transit_to_warehouse';
    if (status.includes('created') || status.includes('booked')) return 'reverse_pickup_created';
    return null;
}

function isReturnRefundEligible(order) {
    const status = String(order?.returnInfo?.status || '').toLowerCase();
    return ['received', 'qc_passed', 'refund_pending'].includes(status);
}

function buildReturnProofUploadError(message, extras = {}) {
    const err = new Error(message);
    err.statusCode = 400;
    err.code = 'RETURN_PROOF_INVALID';
    Object.assign(err, extras);
    return err;
}

function uploadReturnProofToCloudinary(file, orderId) {
    const isVideo = String(file.mimetype || '').startsWith('video/');
    const resourceType = isVideo ? 'video' : 'image';
    return new Promise((resolve, reject) => {
        const uploadOptions = {
            folder: `returns/${orderId}`,
            resource_type: resourceType,
            public_id: `${isVideo ? 'video' : 'image'}-${Date.now()}`
        };
        if (!isVideo) {
            uploadOptions.format = 'webp';
            uploadOptions.transformation = [{ quality: 'auto' }];
        }
        const stream = cloudinary.uploader.upload_stream(uploadOptions, (error, result) => {
            if (error) {
                reject(new Error(`Proof upload failed: ${error.message}`));
                return;
            }
            resolve({
                kind: isVideo ? 'video' : 'image',
                url: result.secure_url,
                publicId: result.public_id
            });
        });
        stream.end(file.buffer);
    });
}

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
    // Use mergeReturnInfo — naive spread can write undefined nested paths
    // (e.g. rtoDeductions) and crash Mongoose cast on save.
    order.returnInfo = mergeReturnInfo(order.returnInfo, {
        refundAmount: totalRefundedInr,
        refundId: entry.refundId,
        status: entry.status
    });
    order.markModified('returnInfo');
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

function isOrderIdDuplicateError(error) {
    if (!error || error.code !== 11000) return false;
    const dup = error.keyPattern?.orderId || error.keyValue?.orderId;
    return Boolean(dup);
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

function isTerminalUnpaidOrder(orderLike) {
    const orderStatus = String(orderLike?.orderStatus || '').toLowerCase();
    const paymentStatus = String(orderLike?.paymentStatus || '').toLowerCase();
    const paid = Number(orderLike?.amountPaidInr || 0);
    const isTerminal = ['cancelled', 'payment_failed'].includes(orderStatus) || paymentStatus === 'failed';
    return isTerminal && paid <= 0.01;
}

function normalizeTerminalUnpaidFinancials(orderLike) {
    if (!isTerminalUnpaidOrder(orderLike)) {
        return false;
    }
    orderLike.amountPaidInr = 0;
    orderLike.balanceDueInr = 0;
    return true;
}

function mapExternalShipmentStatusToOrderStatus(rawStatus) {
    const { mapProviderStatusToOrderStatus } = require('../services/shipmentOps/shiprocketStatusMap');
    return mapProviderStatusToOrderStatus(rawStatus);
}

const {
    canApplyProviderOrderStatus,
    repairOrderStatusForShiprocketRto,
    repairOrderStatusForFalseDeliveredNdr
} = require('../constants/rtoOrderQuery');

function normalizeShipmentEventTimestamp(value) {
    if (!value) return null;
    const dt = new Date(value);
    return Number.isNaN(dt.getTime()) ? null : dt;
}

async function upsertShipmentInfo({
    order,
    shipmentPayload,
    trigger,
    allowOrderStatusUpdate = true
}) {
    if (!order || !shipmentPayload) return false;
    const prevSi = order.shipmentInfo || {};
    const prevAwb = String(prevSi.awbCode || prevSi.trackingNumber || '').trim();
    const prevCourierId = String(prevSi.assignedCourierId || '').trim();
    const prevCourier = String(prevSi.courier || '').trim().toLowerCase();

    const nextShipmentInfo = {
        ...(order.shipmentInfo || {})
    };

    if (Object.prototype.hasOwnProperty.call(shipmentPayload, 'awbCode')) {
        const awbCode = shipmentPayload.awbCode;
        if (awbCode == null || awbCode === '') {
            nextShipmentInfo.awbCode = null;
            nextShipmentInfo.trackingNumber = null;
        } else {
            nextShipmentInfo.trackingNumber = String(awbCode);
            nextShipmentInfo.awbCode = String(awbCode);
        }
    } else if (Object.prototype.hasOwnProperty.call(shipmentPayload, 'trackingNumber')) {
        const trackingNumber = shipmentPayload.trackingNumber;
        if (trackingNumber == null || trackingNumber === '') {
            nextShipmentInfo.trackingNumber = null;
            nextShipmentInfo.awbCode = null;
        } else {
            nextShipmentInfo.trackingNumber = String(trackingNumber);
            nextShipmentInfo.awbCode = String(trackingNumber);
        }
    } else {
        const awbCode = shipmentPayload.awbCode || shipmentPayload.trackingNumber || null;
        if (awbCode) {
            nextShipmentInfo.trackingNumber = String(awbCode);
            nextShipmentInfo.awbCode = String(awbCode);
        }
    }
    if (shipmentPayload.shipmentId != null) {
        nextShipmentInfo.shipmentId = String(shipmentPayload.shipmentId);
    }
    if (shipmentPayload.shiprocketOrderId != null) {
        nextShipmentInfo.shiprocketOrderId = String(shipmentPayload.shiprocketOrderId);
    }
    if (shipmentPayload.shipmozoOrderId != null) {
        nextShipmentInfo.shipmozoOrderId = String(shipmentPayload.shipmozoOrderId);
    }
    if (shipmentPayload.shipmozoReferenceId != null) {
        nextShipmentInfo.shipmozoReferenceId = String(shipmentPayload.shipmozoReferenceId);
    }
    if (Object.prototype.hasOwnProperty.call(shipmentPayload, 'provider')) {
        nextShipmentInfo.provider =
            shipmentPayload.provider == null || shipmentPayload.provider === ''
                ? null
                : String(shipmentPayload.provider);
    }
    if (Object.prototype.hasOwnProperty.call(shipmentPayload, 'shipmozoNeedsManualPickup')) {
        nextShipmentInfo.shipmozoNeedsManualPickup =
            shipmentPayload.shipmozoNeedsManualPickup == null
                ? null
                : Boolean(shipmentPayload.shipmozoNeedsManualPickup);
    }
    if (Object.prototype.hasOwnProperty.call(shipmentPayload, 'assignedCourierId')) {
        nextShipmentInfo.assignedCourierId =
            shipmentPayload.assignedCourierId == null || shipmentPayload.assignedCourierId === ''
                ? null
                : String(shipmentPayload.assignedCourierId);
    }
    if (Object.prototype.hasOwnProperty.call(shipmentPayload, 'courier')) {
        nextShipmentInfo.courier =
            shipmentPayload.courier == null || shipmentPayload.courier === ''
                ? null
                : shipmentPayload.courier;
    }
    if (Object.prototype.hasOwnProperty.call(shipmentPayload, 'labelUrl')) {
        nextShipmentInfo.labelUrl =
            shipmentPayload.labelUrl == null || shipmentPayload.labelUrl === ''
                ? null
                : shipmentPayload.labelUrl;
    }
    if (Object.prototype.hasOwnProperty.call(shipmentPayload, 'manifestUrl')) {
        nextShipmentInfo.manifestUrl =
            shipmentPayload.manifestUrl == null || shipmentPayload.manifestUrl === ''
                ? null
                : shipmentPayload.manifestUrl;
    } else if (shipmentPayload.manifestUrl) {
        nextShipmentInfo.manifestUrl = shipmentPayload.manifestUrl;
    }
    if (Object.prototype.hasOwnProperty.call(shipmentPayload, 'courierAssignNote')) {
        nextShipmentInfo.courierAssignNote =
            shipmentPayload.courierAssignNote == null || shipmentPayload.courierAssignNote === ''
                ? null
                : String(shipmentPayload.courierAssignNote);
    }
    if (Object.prototype.hasOwnProperty.call(shipmentPayload, 'courierSubstitutedFromId')) {
        nextShipmentInfo.courierSubstitutedFromId =
            shipmentPayload.courierSubstitutedFromId == null ? null : Number(shipmentPayload.courierSubstitutedFromId);
    }
    if (Object.prototype.hasOwnProperty.call(shipmentPayload, 'courierSubstitutedFromName')) {
        nextShipmentInfo.courierSubstitutedFromName =
            shipmentPayload.courierSubstitutedFromName == null || shipmentPayload.courierSubstitutedFromName === ''
                ? null
                : String(shipmentPayload.courierSubstitutedFromName);
    }
    if (Object.prototype.hasOwnProperty.call(shipmentPayload, 'providerSnapshot')) {
        nextShipmentInfo.providerSnapshot = shipmentPayload.providerSnapshot || null;
    }
    if (shipmentPayload.manifestGeneratedAt) {
        nextShipmentInfo.manifestGeneratedAt = new Date(shipmentPayload.manifestGeneratedAt);
    }
    if (Object.prototype.hasOwnProperty.call(shipmentPayload, 'pickupDate')) {
        const pd = shipmentPayload.pickupDate;
        nextShipmentInfo.pickupDate =
            pd == null || pd === '' ? null : String(pd).trim() || null;
    }
    if (Object.prototype.hasOwnProperty.call(shipmentPayload, 'shiprocketPickupId')) {
        const pid = shipmentPayload.shiprocketPickupId;
        nextShipmentInfo.shiprocketPickupId =
            pid == null || pid === '' ? null : String(pid).trim() || null;
    }
    if (shipmentPayload.pickupScheduledAt) {
        nextShipmentInfo.pickupScheduledAt = new Date(shipmentPayload.pickupScheduledAt);
    } else if (Object.prototype.hasOwnProperty.call(shipmentPayload, 'pickupScheduledAt')) {
        nextShipmentInfo.pickupScheduledAt = null;
    }
    if (Object.prototype.hasOwnProperty.call(shipmentPayload, 'lastPickupError')) {
        nextShipmentInfo.lastPickupError =
            shipmentPayload.lastPickupError == null || shipmentPayload.lastPickupError === ''
                ? null
                : String(shipmentPayload.lastPickupError);
    }
    if (shipmentPayload.estimatedDelivery) {
        nextShipmentInfo.estimatedDelivery = shipmentPayload.estimatedDelivery;
    }
    if (Object.prototype.hasOwnProperty.call(shipmentPayload, 'manifestDownloaded')) {
        nextShipmentInfo.manifestDownloaded = Boolean(shipmentPayload.manifestDownloaded);
    }
    if (Object.prototype.hasOwnProperty.call(shipmentPayload, 'labelDownloaded')) {
        nextShipmentInfo.labelDownloaded = Boolean(shipmentPayload.labelDownloaded);
    }

    const providerStatus = shipmentPayload.providerStatus || shipmentPayload.currentStatus || null;
    if (providerStatus) {
        nextShipmentInfo.providerStatus = String(providerStatus);
    }
    nextShipmentInfo.lastSyncAt = new Date();
    nextShipmentInfo.lastSyncSource = trigger || 'system';
    nextShipmentInfo.lastError = null;

    if (Object.prototype.hasOwnProperty.call(shipmentPayload, 'events')) {
        const incoming = Array.isArray(shipmentPayload.events) ? shipmentPayload.events : [];
        const previous = Array.isArray(order.shipmentInfo?.rawEvents) ? order.shipmentInfo.rawEvents : [];
        // Empty tracking payload must not wipe prior RTO Delivered / NDR history.
        if (incoming.length === 0 && previous.length > 0) {
            nextShipmentInfo.rawEvents = previous;
        } else if (shipmentPayload.replaceEvents === true) {
            nextShipmentInfo.rawEvents = incoming.slice(0, 80);
        } else {
            const { mergeShipmentTrackingEvents } = require('../services/shipmentOps/trackingEventsMerge');
            nextShipmentInfo.rawEvents = mergeShipmentTrackingEvents(previous, incoming, 80);
        }
    } else if (Array.isArray(shipmentPayload.events) && shipmentPayload.events.length > 0) {
        const { mergeShipmentTrackingEvents } = require('../services/shipmentOps/trackingEventsMerge');
        const previous = Array.isArray(order.shipmentInfo?.rawEvents) ? order.shipmentInfo.rawEvents : [];
        nextShipmentInfo.rawEvents = mergeShipmentTrackingEvents(previous, shipmentPayload.events, 80);
    }

    if (allowOrderStatusUpdate) {
        const previousOrderStatus = String(order.orderStatus || '').toLowerCase();
        const mappedOrderStatus = mapExternalShipmentStatusToOrderStatus(providerStatus);
        if (
            mappedOrderStatus &&
            canApplyProviderOrderStatus(order.orderStatus, mappedOrderStatus, providerStatus)
        ) {
            order.orderStatus = mappedOrderStatus;
            if (mappedOrderStatus === 'shipped' && !nextShipmentInfo.shippedAt) {
                nextShipmentInfo.shippedAt = new Date();
            }
            if (mappedOrderStatus === 'out_for_delivery' && !nextShipmentInfo.outForDeliveryAt) {
                nextShipmentInfo.outForDeliveryAt = new Date();
            }
            if (mappedOrderStatus === 'delivered' && !nextShipmentInfo.deliveredAt) {
                nextShipmentInfo.deliveredAt = new Date();
            }
            // Clear false delivery latch when Shiprocket corrects to NDR / transit / OFD / RTO.
            if (previousOrderStatus === 'delivered' && mappedOrderStatus !== 'delivered') {
                nextShipmentInfo.deliveredAt = null;
            }
        } else {
            repairOrderStatusForShiprocketRto(order);
            if (repairOrderStatusForFalseDeliveredNdr(order)) {
                nextShipmentInfo.deliveredAt = null;
            }
        }
    }

    const nextAwb = String(nextShipmentInfo.awbCode || nextShipmentInfo.trackingNumber || '').trim();
    const nextCourierId = String(nextShipmentInfo.assignedCourierId || '').trim();
    const nextCourier = String(nextShipmentInfo.courier || '').trim().toLowerCase();

    const awbChanged = prevAwb !== nextAwb;
    const courierIdChanged = prevCourierId !== nextCourierId;
    const courierNameChanged = prevCourier !== nextCourier;

    const payloadSetsFreshLabel =
        Object.prototype.hasOwnProperty.call(shipmentPayload, 'labelUrl') &&
        shipmentPayload.labelUrl != null &&
        shipmentPayload.labelUrl !== '';
    const payloadSetsFreshManifest =
        Object.prototype.hasOwnProperty.call(shipmentPayload, 'manifestUrl') &&
        shipmentPayload.manifestUrl != null &&
        shipmentPayload.manifestUrl !== '';

    if (awbChanged || courierIdChanged || courierNameChanged) {
        if (!payloadSetsFreshManifest) {
            nextShipmentInfo.manifestUrl = null;
            nextShipmentInfo.manifestGeneratedAt = null;
            nextShipmentInfo.fulfillmentManifestAwb = null;
        }
        if (!payloadSetsFreshLabel) {
            nextShipmentInfo.labelUrl = null;
            nextShipmentInfo.fulfillmentLabelAwb = null;
        }
        if (!payloadSetsFreshManifest && !payloadSetsFreshLabel) {
            nextShipmentInfo.fulfillmentArtifactAwb = null;
        }
    }

    if (payloadSetsFreshManifest) {
        nextShipmentInfo.fulfillmentManifestAwb = nextAwb || null;
    }
    if (payloadSetsFreshLabel) {
        nextShipmentInfo.fulfillmentLabelAwb = nextAwb || null;
    }
    if (payloadSetsFreshManifest || payloadSetsFreshLabel) {
        nextShipmentInfo.fulfillmentArtifactAwb = nextAwb || null;
    }

    order.shipmentInfo = nextShipmentInfo;
    order.markModified('shipmentInfo');
    await order.save();

    try {
        const { evaluateAndPersistShipmentOps } = require('../services/shipmentOps');
        await evaluateAndPersistShipmentOps(order, { source: trigger || 'upsert_shipment' });
    } catch (opsErr) {
        logger.warn('shipmentOps reconcile failed after upsertShipmentInfo', {
            orderId: order.orderId,
            trigger,
            message: opsErr?.message || String(opsErr)
        });
    }

    return true;
}

async function markShipmentSyncFailure({ order, error, trigger }) {
    if (!order) return;
    order.shipmentInfo = {
        ...(order.shipmentInfo || {}),
        lastSyncAt: new Date(),
        lastSyncSource: trigger || 'system',
        lastError: String(error?.message || error || 'Shipment sync failed'),
        createAttemptCount: Number(order.shipmentInfo?.createAttemptCount || 0) + 1
    };
    order.markModified('shipmentInfo');
    await order.save();
}

async function ensureShipmentForOrder({ order, trigger }) {
    if (!order) return { success: false, code: 'ORDER_REQUIRED', message: 'Order is required.' };

    if (!isLegacyAutoFulfillOnCheckout()) {
        const st = String(order.orderStatus || '').toLowerCase();
        if (st === 'pending') {
            return {
                success: false,
                code: 'ORDER_AWAITING_ADMIN_CONFIRMATION',
                message:
                    'Shipment cannot be created while the order is still pending admin confirmation. After the order is confirmed for fulfilment, retry from the admin panel.'
            };
        }
    }

    const paymentGate = evaluateOrderPaymentForShiprocketFulfillment(order);
    if (!paymentGate.ok) {
        return {
            success: false,
            code: paymentGate.code || 'SHIPMENT_PAYMENT_BLOCKED',
            message: paymentGate.message || 'Payment requirements not met for shipment.',
            details: paymentGate.details || null
        };
    }
    const hasAwb = Boolean(order.shipmentInfo?.awbCode || order.shipmentInfo?.trackingNumber);
    if (hasAwb) {
        return { success: true, alreadyExists: true };
    }

    const provider = resolveOrderShippingProvider(order);

    // ——— Shipmozo path (order stamped at place-order) ———
    if (provider === SHIPPING_PROVIDERS.SHIPMOZO) {
        if (order.shipmentInfo?.shipmentId || order.shipmentInfo?.shipmozoOrderId) {
            return { success: true, alreadyExists: true, pendingAwbAssignment: true };
        }

        const reloadedSm = await Order.findOne({ orderId: order.orderId }).populate(
            'items.productId',
            'name slug variants shipping'
        );
        if (reloadedSm) order = reloadedSm;

        const result = await ShipmozoService.createShipment(order);
        if (!result?.success) {
            await markShipmentSyncFailure({
                order,
                error: result?.error || 'Shipmozo push-order failed',
                trigger
            });
            return {
                success: false,
                code: 'SHIPMENT_CREATE_FAILED',
                message: 'Shipmozo shipment creation failed',
                details: result?.error || null
            };
        }

        await upsertShipmentInfo({
            order,
            shipmentPayload: {
                ...result,
                provider: SHIPPING_PROVIDERS.SHIPMOZO,
                providerStatus: result.providerStatus || 'PUSHED'
            },
            trigger,
            allowOrderStatusUpdate: false
        });
        return { success: true, shipment: result, provider: SHIPPING_PROVIDERS.SHIPMOZO };
    }

    // ——— Shiprocket path (unchanged behavior) ———
    if (!order.shipmentInfo?.shipmentId && order.shipmentInfo?.shiprocketOrderId) {
        const lookup = await ShiprocketService.fetchShipmentIdForForwardOrder({
            shiprocketOrderId: order.shipmentInfo.shiprocketOrderId,
            channelOrderId: order.orderId
        });
        if (lookup.success && lookup.shipmentId) {
            await upsertShipmentInfo({
                order,
                shipmentPayload: {
                    shipmentId: lookup.shipmentId,
                    shiprocketOrderId: String(order.shipmentInfo.shiprocketOrderId),
                    provider: SHIPPING_PROVIDERS.SHIPROCKET
                },
                trigger: `${trigger}_resolve_shipment_id`,
                allowOrderStatusUpdate: false
            });
            order.shipmentInfo = { ...(order.shipmentInfo || {}), shipmentId: String(lookup.shipmentId) };
            order.markModified('shipmentInfo');
        }
    }

    if (order.shipmentInfo?.shipmentId) {
        return { success: true, alreadyExists: true, pendingAwbAssignment: true };
    }

    const reloaded = await Order.findOne({ orderId: order.orderId })
        .populate('items.productId', 'name slug variants shipping');
    if (reloaded) {
        order = reloaded;
    }

    const result = await ShiprocketService.createShipment(order);
    if (result?.adhocPayloadDebug) {
        order.shipmentInfo = order.shipmentInfo || {};
        const events = Array.isArray(order.shipmentInfo.rawEvents) ? order.shipmentInfo.rawEvents : [];
        events.push({
            type: 'adhoc_payload_debug',
            at: new Date(),
            trigger,
            ...result.adhocPayloadDebug
        });
        order.shipmentInfo.rawEvents = events.slice(-20);
        order.markModified('shipmentInfo');
        await order.save();
    }
    if (!result?.success) {
        await markShipmentSyncFailure({ order, error: result?.error || 'createShipment failed', trigger });
        return {
            success: false,
            code: 'SHIPMENT_CREATE_FAILED',
            message: 'Shipment creation failed',
            details: result?.error || null,
            adhocPayloadDebug: result?.adhocPayloadDebug || null
        };
    }

    // Shiprocket "success" must include a tangible reference; otherwise treat as failure.
    const hasTrackingRef = Boolean(result?.awbCode || result?.trackingNumber || result?.shipmentId);
    if (!hasTrackingRef && !result?.mock) {
        await markShipmentSyncFailure({
            order,
            error: result?.raw || result?.providerStatus || 'Shiprocket returned success without AWB/shipmentId',
            trigger
        });
        return {
            success: false,
            code: 'SHIPMENT_CREATE_INCOMPLETE',
            message: 'Shipment creation incomplete',
            details: result?.raw || null
        };
    }

    await upsertShipmentInfo({
        order,
        shipmentPayload: {
            ...result,
            provider: SHIPPING_PROVIDERS.SHIPROCKET,
            // Do NOT force a "shipped-like" status here; let Shiprocket/tracking drive state.
            providerStatus: result.providerStatus || (result.mock ? 'mock_created' : null)
        },
        trigger,
        // Advance orderStatus from carrier only when AWB exists (shipment_id alone = still "invoiced").
        allowOrderStatusUpdate: Boolean(result?.awbCode || result?.trackingNumber)
    });
    return { success: true, shipment: result, provider: SHIPPING_PROVIDERS.SHIPROCKET };
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
        const {
            addressId,
            paymentMethod,
            couponCode,
            onlinePaymentMode = 'full',
            paymentAdvancePercent,
            balanceCollection,
            quoteId
        } = req.body || {};
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

        const checkoutPolicy = await checkoutSettingsService.getPolicyForStorefront(storefront);

        let normalizedOnlinePaymentMode;
        let effectiveAdvancePercent;
        try {
            const sel = resolveAdvancePaymentSelectionWithPolicy({
                paymentPlan: onlinePaymentMode,
                paymentAdvancePercent,
                policy: checkoutPolicy
            });
            normalizedOnlinePaymentMode = sel.normalizedPaymentPlan;
            effectiveAdvancePercent = sel.effectiveAdvancePercent;
        } catch (policyErr) {
            await abortTransactionSafely(session);
            if (idempotency.enabled) {
                await OrderIdempotencyKey.deleteOne({ _id: idempotency.record._id });
            }
            if (policyErr?.statusCode) {
                return sendCheckoutFlowError(
                    res,
                    policyErr,
                    'Checkout validation failed',
                    'ORDER_CHECKOUT_VALIDATION_FAILED'
                );
            }
            throw policyErr;
        }

        try {
            assertStorePolicyAllowsCheckout({
                policy: checkoutPolicy,
                paymentMethod: normalizedPaymentMethod,
                paymentPlan:
                    normalizedPaymentMethod === 'cod' ? 'full' : normalizedOnlinePaymentMode,
                balanceCollection
            });
        } catch (policyErr) {
            await abortTransactionSafely(session);
            if (idempotency.enabled) {
                await OrderIdempotencyKey.deleteOne({ _id: idempotency.record._id });
            }
            if (policyErr?.statusCode) {
                return sendCheckoutFlowError(
                    res,
                    policyErr,
                    'Checkout validation failed',
                    'ORDER_CHECKOUT_VALIDATION_FAILED'
                );
            }
            throw policyErr;
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

        if (!addressBelongsToStorefront(address, storefront)) {
            await abortTransactionSafely(session);
            if (idempotency.enabled) {
                await OrderIdempotencyKey.deleteOne({ _id: idempotency.record._id });
            }
            return res.status(403).json({
                success: false,
                code: 'ADDRESS_STOREFRONT_MISMATCH',
                message: 'Address does not belong to this storefront'
            });
        }

        // 2. Get user's cart (same storefront)
        const cartDoc = await findCartForStorefront(userId, storefront).session(session);
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
        const quoteHasPaymentLock = Boolean(String(quote.confirmedPaymentMethod || '').trim());
        const confirmedPaymentMethod = quoteHasPaymentLock
            ? normalizePaymentMethod(quote.confirmedPaymentMethod)
            : normalizedPaymentMethod;
        const confirmedPaymentPlan = quoteHasPaymentLock
            ? normalizePaymentPlan(quote.confirmedPaymentPlan || 'full')
            : normalizedOnlinePaymentMode;
        const confirmedAdvancePercentRaw = parseQuoteLockedAdvancePercent(quote.confirmedAdvancePercent);
        const defaultAdvancePercent = resolveDefaultAdvancePercent();
        const policyAdvancePercent =
            confirmedPaymentPlan === 'advance' && effectiveAdvancePercent != null
                ? roundMoney2(effectiveAdvancePercent)
                : null;
        if (confirmedPaymentPlan === 'advance' && confirmedAdvancePercentRaw == null) {
            throw createQuoteStaleError('quote_advance_missing', {
                message: 'Checkout quote is missing advance payment details. Please reconfirm checkout.'
            });
        }
        const confirmedAdvancePercent =
            confirmedPaymentPlan === 'advance' ? confirmedAdvancePercentRaw : null;

        if (confirmedPaymentMethod !== normalizedPaymentMethod) {
            throw createQuoteStaleError('payment_method_changed', {
                message: 'Payment method changed after quote confirmation. Please reconfirm checkout.'
            });
        }
        if (confirmedPaymentPlan !== normalizedOnlinePaymentMode) {
            throw createQuoteStaleError('payment_plan_changed', {
                message: 'Payment plan changed after quote confirmation. Please reconfirm checkout.'
            });
        }
        if (
            confirmedPaymentPlan === 'advance' &&
            policyAdvancePercent != null &&
            confirmedAdvancePercent != null &&
            roundMoney2(policyAdvancePercent) !== roundMoney2(confirmedAdvancePercent)
        ) {
            throw createQuoteStaleError('advance_percent_changed', {
                message: 'Advance percent changed after quote confirmation. Please reconfirm checkout.'
            });
        }

        const quoteBalanceLocked =
            confirmedPaymentPlan === 'advance'
                ? (String(quote.confirmedBalanceCollection || '') === 'cod' ? 'cod' : 'online')
                : 'online';
        const requestBalance = normalizeBalanceCollection(balanceCollection);
        if (confirmedPaymentPlan === 'advance' && quoteBalanceLocked !== requestBalance) {
            throw createQuoteStaleError('balance_collection_changed', {
                message: 'Balance payment method changed after quote confirmation. Please reconfirm checkout.'
            });
        }

        const isAdvanceBalanceCod = isAdvanceBalanceCodCheckout({
            paymentMethod: normalizedPaymentMethod,
            paymentPlan: confirmedPaymentPlan,
            balanceCollection: quoteBalanceLocked
        });

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
        if (isAdvanceBalanceCod && quote.shippingMeta?.codAvailable === false) {
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
                courierCompanyId:
                    quote.shippingMeta?.courierCompanyId != null &&
                    Number.isFinite(Number(quote.shippingMeta.courierCompanyId))
                        ? Number(quote.shippingMeta.courierCompanyId)
                        : null,
                isDeliverable: true,
                codAvailable: quote.shippingMeta?.codAvailable !== false,
                freightInr:
                    quote.shippingMeta?.freightInr != null &&
                    Number.isFinite(Number(quote.shippingMeta.freightInr))
                        ? roundMoney2(Number(quote.shippingMeta.freightInr))
                        : null,
                codFeeInr:
                    quote.shippingMeta?.codFeeInr != null &&
                    Number.isFinite(Number(quote.shippingMeta.codFeeInr))
                        ? roundMoney2(Number(quote.shippingMeta.codFeeInr))
                        : null
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

        const advancePercent =
            confirmedAdvancePercent != null ? confirmedAdvancePercent : defaultAdvancePercent;

        let last;
        let priced;
        try {
            if (normalizedPaymentMethod === 'cod') {
                last = await buildTotals(false, 0);
                for (let i = 0; i < 2; i++) {
                    const codVal = roundMoney2(last.subtotal + last.tax - last.discount + last.deliveryCharges);
                    last = await buildTotals(false, codVal);
                }
                priced = await buildTotals(
                    true,
                    roundMoney2(last.subtotal + last.tax - last.discount + last.deliveryCharges)
                );
            } else if (isAdvanceBalanceCod) {
                last = await buildTotals(false, 0);
                for (let i = 0; i < 2; i++) {
                    const totalInr = roundMoney2(last.subtotal + last.tax - last.discount + last.deliveryCharges);
                    const advInrRaw = roundMoney2((totalInr * advancePercent) / 100);
                    const advInr = Math.max(1, Math.min(roundMoney2(totalInr - 0.01), advInrRaw));
                    const balanceCod = roundMoney2(totalInr - advInr);
                    last = await buildTotals(false, balanceCod);
                }
                const totalInr = roundMoney2(last.subtotal + last.tax - last.discount + last.deliveryCharges);
                const advInrRaw = roundMoney2((totalInr * advancePercent) / 100);
                const advInr = Math.max(1, Math.min(roundMoney2(totalInr - 0.01), advInrRaw));
                const finalBalanceCod = roundMoney2(totalInr - advInr);
                priced = await buildTotals(true, finalBalanceCod);
            } else {
                last = await buildTotals(false, 0);
                priced = await buildTotals(true, 0);
            }
        } catch (e) {
            await abortTransactionSafely(session);
            session.endSession();
            return sendCheckoutFlowError(res, e, 'Checkout validation failed', 'ORDER_CHECKOUT_VALIDATION_FAILED');
        }

        const { orderItems, subtotal, deliveryCharges, tax, discount, appliedCouponCode, totalAmount, lines } = priced;
        const orderItemsWithCodes = attachProductCodesToOrderItems(orderItems, lines);
        const shippingWeightSnapshot = buildShippingWeightSnapshotFromCheckoutLines({
            lines: priced.lines,
            totalWeightKg: priced.totalWeight,
            dims: priced.dims
        });
        const pricedShip = priced.deliveryMeta || {};
        const quoteShip = quote.shippingMeta || {};
        const resolvedCourierCompanyId =
            pricedShip.courierCompanyId != null && Number.isFinite(Number(pricedShip.courierCompanyId))
                ? Number(pricedShip.courierCompanyId)
                : quoteShip.courierCompanyId != null && Number.isFinite(Number(quoteShip.courierCompanyId))
                  ? Number(quoteShip.courierCompanyId)
                  : null;
        const resolvedShipmozoCourierId =
            pricedShip.shipmozoCourierId != null && Number.isFinite(Number(pricedShip.shipmozoCourierId))
                ? Number(pricedShip.shipmozoCourierId)
                : quoteShip.shipmozoCourierId != null && Number.isFinite(Number(quoteShip.shipmozoCourierId))
                  ? Number(quoteShip.shipmozoCourierId)
                  : pricedShip.shippingProvider === 'shipmozo' || quoteShip.shippingProvider === 'shipmozo'
                    ? resolvedCourierCompanyId
                    : null;
        let orderShippingProvider =
            pricedShip.shippingProvider ||
            quoteShip.shippingProvider ||
            null;
        if (orderShippingProvider !== 'shipmozo' && orderShippingProvider !== 'shiprocket') {
            try {
                orderShippingProvider = await shippingProviderSettingsService.getActiveProviderForNewOrders();
            } catch (_) {
                orderShippingProvider = SHIPPING_PROVIDERS.SHIPROCKET;
            }
        }
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

        // Allocate orderId before stock reserve (inventory API keys holds by orderId).
        let candidateOrderId = null;
        for (let idAttempt = 0; idAttempt < 8; idAttempt++) {
            const candidate = generateOrderId({
                storefront,
                userType: finalUserType
            });
            const exists = await Order.exists({ orderId: candidate }).session(session);
            if (!exists) {
                candidateOrderId = candidate;
                break;
            }
        }
        if (!candidateOrderId) {
            throw createCheckoutFlowError({
                statusCode: 503,
                code: 'ORDER_ID_GENERATION_FAILED',
                message: 'Could not allocate a unique order ID. Please retry checkout.'
            });
        }

        // Inventory reserve (preferred) or Mongo fallback. True OOS from inventory fails checkout.
        const inventoryHold = await reserveCheckoutStock({
            orderId: candidateOrderId,
            storefront,
            lines,
            session
        });
        // If inventory hold succeeded but later steps fail, release in catch.
        req._pendingInventoryReleaseOrderId = inventoryHold.inventoryReserved
            ? candidateOrderId
            : null;

        let razorpayChargePaise = Math.round(roundMoney2(totalAmount) * 100);
        let splitMode = 'full';
        let balanceDueInr = 0;
        let amountPaidInr = 0;

        if (normalizedPaymentMethod === 'online' && String(confirmedPaymentPlan).toLowerCase() === 'advance') {
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
            items: orderItemsWithCodes,
            subtotal: subtotal,
            deliveryCharges: deliveryCharges,
            deliveryFreightInr:
                priced.deliveryMeta?.freightInr != null &&
                Number.isFinite(Number(priced.deliveryMeta.freightInr))
                    ? roundMoney2(Number(priced.deliveryMeta.freightInr))
                    : quote.shippingMeta?.freightInr != null &&
                        Number.isFinite(Number(quote.shippingMeta.freightInr))
                      ? roundMoney2(Number(quote.shippingMeta.freightInr))
                      : null,
            deliveryCodFeeInr:
                priced.deliveryMeta?.codFeeInr != null &&
                Number.isFinite(Number(priced.deliveryMeta.codFeeInr))
                    ? roundMoney2(Number(priced.deliveryMeta.codFeeInr))
                    : quote.shippingMeta?.codFeeInr != null &&
                        Number.isFinite(Number(quote.shippingMeta.codFeeInr))
                      ? roundMoney2(Number(quote.shippingMeta.codFeeInr))
                      : null,
            tax: tax,
            discount: discount,
            totalAmount: totalAmount,
            address: addressId,
            addressSnapshot: address.toObject(),
            userType: finalUserType,
            storefront,
            shippingProvider: orderShippingProvider,
            inventoryHold,
            orderStatus:
                isLegacyAutoFulfillOnCheckout() && normalizedPaymentMethod === 'cod' ? 'confirmed' : 'pending',
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
                balanceCollectionMethod:
                    splitMode === 'advance' ? (isAdvanceBalanceCod ? 'cod' : 'online') : 'online',
                fullOrderAmountPaise: Math.round(roundMoney2(totalAmount) * 100),
                quoteId: String(quote._id),
                sessions: []
            },
            shippingSnapshot: {
                courierName: pricedShip.courierName || quoteShip.courierName || null,
                estimatedDays: pricedShip.estimatedDays ?? quoteShip.estimatedDays ?? null,
                courierCompanyId: resolvedCourierCompanyId,
                shipmozoCourierId: resolvedShipmozoCourierId,
                provider: orderShippingProvider,
                pickupsAutomaticallyScheduled:
                    pricedShip.pickupsAutomaticallyScheduled != null
                        ? Boolean(pricedShip.pickupsAutomaticallyScheduled)
                        : quoteShip.pickupsAutomaticallyScheduled != null
                          ? Boolean(quoteShip.pickupsAutomaticallyScheduled)
                          : null
            },
            shippingWeightSnapshot
        };

        // 9. Persist order under pre-allocated orderId.
        let order = new Order({
            orderId: candidateOrderId,
            ...orderPayload
        });
        try {
            await order.save({ session });
        } catch (saveError) {
            if (isOrderIdDuplicateError(saveError)) {
                throw createCheckoutFlowError({
                    statusCode: 503,
                    code: 'ORDER_ID_GENERATION_FAILED',
                    message: 'Could not allocate a unique order ID. Please retry checkout.'
                });
            }
            throw saveError;
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
        req._pendingInventoryReleaseOrderId = null;

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

        if (isLegacyAutoFulfillOnCheckout() && normalizedPaymentMethod === 'cod') {
            try {
                const commitRes = await commitOrderStockHold(order);
                if (commitRes?.ok) {
                    await order.save();
                }
            } catch (codCommitErr) {
                logger.error('COD auto-confirm inventory commit failed', buildRequestLogContext(req, {
                    orderId: order.orderId,
                    error: codCommitErr?.message || String(codCommitErr)
                }));
            }
            ensureShipmentForOrder({
                order,
                trigger: 'cod_order_created'
            }).catch((shipmentError) => {
                logger.error('COD shipment enqueue failed', buildRequestLogContext(req, {
                    orderId: order.orderId,
                    error: shipmentError?.message || String(shipmentError)
                }));
            });
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
        const pendingReleaseId = req._pendingInventoryReleaseOrderId;
        if (pendingReleaseId) {
            try {
                await releaseInventoryHoldByOrderId(pendingReleaseId, {
                    trigger: 'createOrder_rollback'
                });
            } catch (releaseErr) {
                logger.error('Failed to release inventory hold after createOrder rollback', {
                    orderId: pendingReleaseId,
                    message: releaseErr?.message || String(releaseErr)
                });
            }
            req._pendingInventoryReleaseOrderId = null;
        }
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
            const { dirty } = await applySuccessfulOnlineCaptureSideEffects(order, 'verify_idempotent');
            if (dirty) {
                await order.save();
            }
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

        if (
            isLegacyAutoFulfillOnCheckout() &&
            order.paymentStatus === 'paid' &&
            String(order.orderStatus || '').toLowerCase() === 'confirmed'
        ) {
            const { dirty } = await applySuccessfulOnlineCaptureSideEffects(order, 'verify_already_confirmed');
            if (dirty) {
                await order.save();
            }
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

        // Fully paid + stuck terminal orderStatus (race / old bug) — heal without double-counting.
        if (
            String(order.paymentStatus || '').toLowerCase() === 'paid' &&
            Number(order.amountPaidInr || 0) > 0.01
        ) {
            const { dirty } = await applySuccessfulOnlineCaptureSideEffects(order, 'verify_already_paid');
            if (dirty) {
                order.markModified('paymentInfo');
                await order.save();
            }
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
            order.balanceDueInr = 0;
        } else {
            order.paymentStatus = 'partially_paid';
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

        await applySuccessfulOnlineCaptureSideEffects(order, 'payment_verified');

        order.markModified('paymentInfo');
        await order.save();

        const shouldEnqueueShipmentAfterVerify =
            isLegacyAutoFulfillOnCheckout() &&
            !order.shipmentInfo?.trackingNumber &&
            (order.paymentStatus === 'paid' ||
                (String(order.paymentInfo?.balanceCollectionMethod || '') === 'cod' &&
                    order.paymentStatus === 'partially_paid'));
        if (shouldEnqueueShipmentAfterVerify) {
            ensureShipmentForOrder({
                order,
                trigger: 'payment_verified'
            }).catch((shipmentError) => {
                logger.error('Shipment creation failed after payment verification', {
                    orderId: order.orderId,
                    error: shipmentError?.message || String(shipmentError)
                });
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
                if (!order) {
                    break;
                }
                if (order.paymentStatus === 'paid') {
                    const { dirty } = await applySuccessfulOnlineCaptureSideEffects(
                        order,
                        'webhook_already_paid'
                    );
                    if (dirty) {
                        await order.save();
                    }
                    break;
                }

                order.paymentInfo = order.paymentInfo || {};
                order.paymentInfo.capturedPaymentIds = order.paymentInfo.capturedPaymentIds || [];
                if (order.paymentInfo.capturedPaymentIds.includes(payment.id)) {
                    const { dirty } = await applySuccessfulOnlineCaptureSideEffects(
                        order,
                        'webhook_idempotent'
                    );
                    if (dirty) {
                        await order.save();
                    }
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
                    order.balanceDueInr = 0;
                } else {
                    order.paymentStatus = 'partially_paid';
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
                await applySuccessfulOnlineCaptureSideEffects(order, 'razorpay_webhook_payment_captured');

                order.markModified('paymentInfo');
                await order.save();

                const shouldEnqueueShipmentAfterWebhook =
                    isLegacyAutoFulfillOnCheckout() &&
                    !order.shipmentInfo?.trackingNumber &&
                    (order.paymentStatus === 'paid' ||
                        (String(order.paymentInfo?.balanceCollectionMethod || '') === 'cod' &&
                            order.paymentStatus === 'partially_paid'));
                if (shouldEnqueueShipmentAfterWebhook) {
                    ensureShipmentForOrder({
                        order,
                        trigger: 'razorpay_webhook_payment_captured'
                    }).catch((shipmentError) => {
                        logger.error('Shipment creation failed after webhook capture', {
                            orderId: order.orderId,
                            error: shipmentError?.message || String(shipmentError)
                        });
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
                if (!failedOrder) {
                    break;
                }

                // Late / out-of-order failure must never overwrite a settled payment.
                if (
                    isMoneyCapturedPaymentStatus(failedOrder.paymentStatus) ||
                    Number(failedOrder.amountPaidInr || 0) > 0.01
                ) {
                    const { dirty } = await applySuccessfulOnlineCaptureSideEffects(
                        failedOrder,
                        'webhook_failed_ignored_already_paid'
                    );
                    if (dirty) {
                        await failedOrder.save();
                    }
                    logger.info('[paymentState] Ignored payment.failed — order already has capture', {
                        orderId: failedOrder.orderId,
                        paymentStatus: failedOrder.paymentStatus,
                        failedPaymentId: failedPayment.id || null
                    });
                    break;
                }

                // Session-level failure only: keep order pending so customer can retry in-hold.
                // Terminal unpaid states come from abandon / payment-hold expiry / explicit cancel.
                const recorded = recordOnlinePaymentAttemptFailure(failedOrder, failedPayment);
                if (recorded.changed) {
                    await failedOrder.save();
                    logger.info('[paymentState] Recorded payment attempt failure (non-terminal)', {
                        orderId: failedOrder.orderId,
                        razorpayOrderId: failedPayment.order_id || null,
                        razorpayPaymentId: failedPayment.id || null
                    });
                }
                break;
            }

            case 'refund.created':
            case 'refund.processed': {
                const refund = payload.refund.entity;
                const refundOrder = await Order.findOne({ 'paymentInfo.razorpayPaymentId': refund.payment_id });
                if (refundOrder) {
                    await applyRefundEntryToOrder(refundOrder, refund);
                    try {
                        const { handleRazorpayRefundForRtoNotifications } = require('../services/rtoNotification.service');
                        await handleRazorpayRefundForRtoNotifications(refundOrder, refund, event);
                    } catch (notifyErr) {
                        logger.warn('[rtoNotification] Razorpay refund notify failed', {
                            message: notifyErr.message,
                            event
                        });
                    }
                }
                break;
            }

            case 'refund.failed': {
                const refund = payload.refund.entity;
                const refundOrder = await Order.findOne({ 'paymentInfo.razorpayPaymentId': refund.payment_id });
                if (refundOrder) {
                    try {
                        const { handleRazorpayRefundForRtoNotifications } = require('../services/rtoNotification.service');
                        await handleRazorpayRefundForRtoNotifications(refundOrder, refund, event);
                    } catch (notifyErr) {
                        logger.warn('[rtoNotification] Razorpay refund failed notify error', {
                            message: notifyErr.message
                        });
                    }
                }
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

// ========== SHIPROCKET WEBHOOK ==========
exports.shiprocketWebhook = async (req, res) => {
    try {
        const configuredToken = String(process.env.SHIPROCKET_WEBHOOK_TOKEN || '').trim();
        const incomingToken = String(req.headers['x-shiprocket-token'] || req.headers['x-webhook-token'] || '').trim();
        if (configuredToken && incomingToken !== configuredToken) {
            return respondOrderError(res, 401, 'SHIPROCKET_WEBHOOK_UNAUTHORIZED', 'Invalid Shiprocket webhook token');
        }

        const payload = req.body || {};
        const channelOrderId = String(
            payload.order_id || payload.orderId || payload.order_reference_id || payload.reference_id || ''
        ).trim();
        const awbCode = String(payload.awb_code || payload.awb || '').trim();
        const shipmentIdRaw = payload.shipment_id ?? payload.shipmentId;
        const shipmentId =
            shipmentIdRaw != null && String(shipmentIdRaw).trim() !== ''
                ? String(shipmentIdRaw).trim()
                : '';
        const shiprocketOrderIdRaw =
            payload.sr_order_id ?? payload.shiprocket_order_id ?? payload.sr_orderId;
        const shiprocketOrderId =
            shiprocketOrderIdRaw != null && String(shiprocketOrderIdRaw).trim() !== ''
                ? String(shiprocketOrderIdRaw).trim()
                : '';

        if (!channelOrderId && !awbCode && !shipmentId && !shiprocketOrderId) {
            return respondOrderError(
                res,
                400,
                'SHIPROCKET_WEBHOOK_ORDER_ID_REQUIRED',
                'order_id (or AWB / shipment_id / shiprocket order id) is required in webhook payload'
            );
        }

        let order = null;
        if (channelOrderId) {
            order = await Order.findOne({ orderId: channelOrderId });
        }
        // Fallback when channel order_id is missing or is Shiprocket's numeric id.
        if (!order && shiprocketOrderId) {
            order = await Order.findOne({ 'shipmentInfo.shiprocketOrderId': shiprocketOrderId });
        }
        if (!order && shipmentId) {
            order = await Order.findOne({ 'shipmentInfo.shipmentId': shipmentId });
        }
        if (!order && awbCode) {
            order = await Order.findOne({
                $or: [
                    { 'shipmentInfo.awbCode': awbCode },
                    { 'shipmentInfo.trackingNumber': awbCode }
                ]
            });
        }
        if (!order) {
            return respondOrderError(res, 404, 'ORDER_NOT_FOUND', 'Order not found for webhook payload');
        }

        const previousProviderStatus = order.shipmentInfo?.providerStatus || null;
        const previousOrderStatus = order.orderStatus;

        const providerStatus =
            payload.current_status ||
            payload.shipment_status ||
            payload.status ||
            payload.current_status_description ||
            null;
        const mappedReturnStatus = mapReturnCarrierStatus(providerStatus);

        const { detectResetFromWebhookPayload, applyLocalShipmentReset } = require('../services/shiprocketReconcile.service');
        const resetCheck = detectResetFromWebhookPayload(payload, order);

        const eventTimestamp = normalizeShipmentEventTimestamp(
            payload.event_time ||
            payload.updated_at ||
            payload.status_date ||
            payload.timestamp
        ) || new Date();

        const nextEvents = Array.isArray(order.shipmentInfo?.rawEvents)
            ? [...order.shipmentInfo.rawEvents]
            : [];
        nextEvents.push({
            status: providerStatus || 'Shipment Update',
            code: payload.status_code || payload.current_status_code || null,
            location: payload.location || payload.city || null,
            description: payload.remark || payload.comment || payload.message || null,
            at: eventTimestamp,
            raw: payload
        });

        if (resetCheck.resetDetected) {
            await applyLocalShipmentReset(order, {
                reason: resetCheck.reason || providerStatus || 'Shipment reset on Shiprocket',
                trigger: 'shiprocket_webhook_reset',
                appendEvent: false
            });
            const freshAfterReset = await Order.findOne({ orderId: order.orderId });
            if (freshAfterReset) {
                freshAfterReset.shipmentInfo = {
                    ...(freshAfterReset.shipmentInfo || {}),
                    rawEvents: nextEvents.slice(-50),
                    lastSyncAt: new Date(),
                    lastSyncSource: 'shiprocket_webhook'
                };
                freshAfterReset.markModified('shipmentInfo');
                await freshAfterReset.save();
            }
        } else {
            await upsertShipmentInfo({
                order,
                shipmentPayload: {
                    awbCode: payload.awb_code || payload.awb || undefined,
                    trackingNumber: payload.awb_code || payload.awb || undefined,
                    shipmentId: payload.shipment_id || undefined,
                    courier: payload.courier_name || payload.courier || undefined,
                    providerStatus,
                    events: nextEvents.slice(-50),
                    estimatedDelivery: payload.estimated_delivery_date || order.shipmentInfo?.estimatedDelivery || null
                },
                trigger: 'shiprocket_webhook',
                allowOrderStatusUpdate: true
            });
        }

        if (mappedReturnStatus && order.returnInfo && String(order.returnInfo.status || '').trim()) {
            const previousReturnStatus = String(order.returnInfo.status || '').toLowerCase();
            order.returnInfo = mergeReturnInfo(order.returnInfo, {
                reverseProviderStatus: providerStatus || order.returnInfo?.reverseProviderStatus || null,
                reverseLastSyncAt: new Date(),
                reverseLastError: null,
                status: mappedReturnStatus,
                reverseEvents: nextEvents.slice(-50)
            });
            if (
                mappedReturnStatus === 'received' &&
                ['approved', 'reverse_pickup_created', 'pickup_in_progress', 'in_transit_to_warehouse'].includes(previousReturnStatus)
            ) {
                order.returnInfo.status = 'refund_pending';
            }
            order.markModified('returnInfo');
            await order.save();
        }

        try {
            const { handleShiprocketWebhookForRtoNotifications } = require('../services/rtoNotification.service');
            await handleShiprocketWebhookForRtoNotifications({
                orderId: order.orderId,
                previousProviderStatus,
                previousOrderStatus
            });
        } catch (notifyErr) {
            logger.warn('[rtoNotification] Shiprocket webhook notify failed', {
                orderId: order.orderId,
                message: notifyErr.message
            });
        }

        return res.json({ success: true });
    } catch (error) {
        logger.error('Shiprocket webhook error', {
            message: error.message,
            stack: error.stack
        });
        return respondOrderError(res, 500, 'SHIPROCKET_WEBHOOK_FAILED', 'Failed to process Shiprocket webhook');
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
        if (String(order.paymentInfo?.balanceCollectionMethod || '') === 'cod') {
            return respondOrderError(
                res,
                400,
                'BALANCE_COD_AT_DELIVERY',
                'The remaining balance is collected on delivery. Online balance payment is not available for this order.'
            );
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

        const orderStatusLower = String(order.orderStatus || '').toLowerCase();
        const paymentStatusLower = String(order.paymentStatus || '').toLowerCase();
        const unpaidOnlineAwaitingPay =
            Number(order.amountPaidInr || 0) <= 0.01 &&
            (orderStatusLower === 'pending' || orderStatusLower === 'payment_failed') &&
            (paymentStatusLower === 'pending' || paymentStatusLower === 'failed');

        if (!unpaidOnlineAwaitingPay) {
            if (orderStatusLower !== 'pending') {
                return res.status(409).json({
                    success: false,
                    code: 'INVALID_ORDER_STATE',
                    message: `Order is ${order.orderStatus}. Retry payment is only for orders awaiting first payment.`
                });
            }
            if (paymentStatusLower !== 'pending') {
                return res.status(409).json({
                    success: false,
                    code: 'INVALID_PAYMENT_STATE',
                    message: 'Payment already progressed. Use pay-balance if you owe a remaining amount.'
                });
            }
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

        // Re-open checkout after a prior failed attempt (legacy webhook terminalized the order).
        if (orderStatusLower === 'payment_failed' || paymentStatusLower === 'failed') {
            order.orderStatus = 'pending';
            order.paymentStatus = 'pending';
            order.balanceDueInr = roundMoney2(order.totalAmount || 0);
            order.amountPaidInr = 0;
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

/**
 * User dismissed Razorpay (or never completed) while still on checkout — void the pending
 * unpaid online order, release reserved stock, and merge order lines back into the cart.
 * Idempotent for orders already voided via this path or payment hold timeout (cart already restored).
 */
exports.abandonOnlineCheckout = async (req, res) => {
    const { orderId } = req.params;
    const userId = req.userId;

    try {
        const oid = orderId != null ? String(orderId).trim() : '';
        if (!oid) {
            return respondOrderError(res, 400, 'INVALID_ORDER_ID', 'Order id is required');
        }

        const existing = await Order.findOne({ orderId: oid, userId }).lean();
        if (!existing) {
            return respondOrderError(res, 404, 'ORDER_NOT_FOUND', 'Order not found');
        }

        const priorReason = String(existing.paymentInfo?.cancellationReason || '');
        if (String(existing.orderStatus || '').toLowerCase() === 'cancelled') {
            if (
                priorReason === 'checkout_gateway_dismissed' ||
                priorReason === 'payment_timeout'
            ) {
                return res.json({
                    success: true,
                    alreadyProcessed: true,
                    message: 'Order was already cancelled.'
                });
            }
            return respondOrderError(
                res,
                409,
                'ORDER_NOT_ELIGIBLE',
                'This order cannot be returned to checkout. Use My orders if you need help.'
            );
        }

        if (String(existing.orderStatus || '').toLowerCase() !== 'pending') {
            return respondOrderError(
                res,
                409,
                'ORDER_NOT_ELIGIBLE',
                'Only a pending unpaid checkout can be returned to the cart.'
            );
        }

        if (String(existing.paymentStatus || '').toLowerCase() !== 'pending') {
            return respondOrderError(
                res,
                409,
                'INVALID_PAYMENT_STATE',
                'Payment is no longer pending. Check My orders.'
            );
        }

        if (String(existing.paymentInfo?.method || '').toLowerCase() !== 'online') {
            return respondOrderError(
                res,
                400,
                'PAYMENT_NOT_ONLINE',
                'This action applies only to online checkout orders.'
            );
        }

        const paid = Number(existing.amountPaidInr || 0);
        if (paid > 0.01) {
            return respondOrderError(
                res,
                409,
                'USE_PAY_BALANCE_ENDPOINT',
                'A payment instalment is already recorded. Complete payment from My orders.'
            );
        }

        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            const order = await Order.findOne({
                orderId: oid,
                userId,
                orderStatus: 'pending',
                paymentStatus: 'pending',
                'paymentInfo.method': 'online',
                $or: [{ amountPaidInr: { $lte: 0.005 } }, { amountPaidInr: { $exists: false } }]
            }).session(session);

            if (!order) {
                await session.abortTransaction();
                session.endSession();

                const again = await Order.findOne({ orderId: oid, userId }).lean();
                if (again && String(again.orderStatus || '').toLowerCase() === 'cancelled') {
                    const r = String(again.paymentInfo?.cancellationReason || '');
                    if (r === 'checkout_gateway_dismissed' || r === 'payment_timeout') {
                        return res.json({
                            success: true,
                            alreadyProcessed: true,
                            message: 'Order was already cancelled.'
                        });
                    }
                }

                return respondOrderError(
                    res,
                    409,
                    'CHECKOUT_STATE_CHANGED',
                    'Checkout changed while processing. Refresh the page or open My orders.'
                );
            }

            order.orderStatus = 'cancelled';
            order.paymentStatus = 'failed';
            order.paymentInfo = order.paymentInfo || {};
            order.paymentInfo.status = 'abandoned';
            order.paymentInfo.cancellationReason = 'checkout_gateway_dismissed';
            order.paymentInfo.cancelledAt = new Date();
            order.markModified('paymentInfo');
            normalizeTerminalUnpaidFinancials(order);

            await order.save({ session });
            await releaseOrderStockHold(order, session);
            await order.save({ session });
            await mergeOrderLineItemsIntoUserCart(order.userId, order.items, session, order.storefront || 'ecomm');

            await session.commitTransaction();
            session.endSession();

            logger.info('abandonOnlineCheckout: voided pending order and restored cart', {
                orderId: order.orderId,
                userId: String(userId)
            });

            return res.json({
                success: true,
                alreadyProcessed: false,
                orderId: order.orderId,
                message: 'Returned to checkout. You can change payment options and place the order again.'
            });
        } catch (inner) {
            await session.abortTransaction().catch(() => {});
            session.endSession();
            logger.error('abandonOnlineCheckout transaction failed', {
                orderId: oid,
                message: inner.message,
                stack: inner.stack
            });
            return respondOrderError(res, 500, 'ABANDON_CHECKOUT_FAILED', 'Could not return to checkout. Try again or open My orders.', {
                error: inner.message
            });
        }
    } catch (error) {
        logger.error('abandonOnlineCheckout', { message: error.message, stack: error.stack });
        return respondOrderError(res, 500, 'INTERNAL_ERROR', 'Could not return to checkout');
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

        // Self-heal historical split state: paid/partially_paid but orderStatus still payment_failed.
        if (
            isMoneyCapturedPaymentStatus(order.paymentStatus) &&
            Number(order.amountPaidInr || 0) > 0.01
        ) {
            try {
                const { dirty } = await applySuccessfulOnlineCaptureSideEffects(order, 'get_order_self_heal');
                if (dirty) {
                    await order.save();
                }
            } catch (healErr) {
                logger.warn('[getOrder] payment state self-heal skipped', {
                    orderId,
                    message: healErr?.message || String(healErr)
                });
            }
        }

        if (isOrderStaff) {
            const {
                ensureShiprocketPickupId,
                isEligibleForShiprocketPickupIdBackfill
            } = require('../services/shiprocketReconcile.service');
            if (isEligibleForShiprocketPickupIdBackfill(order.shipmentInfo)) {
                try {
                    const idResult = await ensureShiprocketPickupId(order, 'admin_order_detail_pickup_id');
                    if (idResult.success && idResult.shiprocketPickupId) {
                        order.shipmentInfo.shiprocketPickupId = idResult.shiprocketPickupId;
                    }
                } catch (pickupIdErr) {
                    logger.warn('[getOrder] SRPID backfill skipped', {
                        orderId,
                        message: pickupIdErr?.message || String(pickupIdErr)
                    });
                }
            }
        }

        const transformedOrder = order.toObject();
        normalizeTerminalUnpaidFinancials(transformedOrder);

        const isCancelledUnavailable =
            String(transformedOrder.orderStatus || '').toLowerCase() === 'cancelled' &&
            (Boolean(transformedOrder.paymentInfo?.itemsUnavailableCancel) ||
                String(transformedOrder.paymentInfo?.cancellationReason || '') === 'admin_amended_empty');

        transformedOrder.items = (transformedOrder.items || []).map((item) => {
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
                unavailable: isCancelledUnavailable,
                lineStatus: isCancelledUnavailable ? 'cancelled_unavailable' : 'active',
                productId: {
                    _id: product?._id,
                    name: product?.name,
                    slug: product?.slug,
                    images: variant?.images || []
                }
            };
        });

        // Heal legacy empty-cancel rows that wiped items — rebuild display from edit history / notes.
        if (
            (!transformedOrder.items || transformedOrder.items.length === 0) &&
            String(transformedOrder.orderStatus || '').toLowerCase() === 'cancelled'
        ) {
            const historyChanges =
                (transformedOrder.adminEditHistory || [])
                    .filter((h) => h?.action === 'cancel_empty_after_edit')
                    .flatMap((h) => (Array.isArray(h?.metadata?.changes) ? h.metadata.changes : [])) || [];
            const noteChanges =
                (transformedOrder.customerFacingNotes || [])
                    .filter((n) => n?.kind === 'order_cancelled_empty')
                    .flatMap((n) => (Array.isArray(n?.metadata?.changes) ? n.metadata.changes : [])) || [];
            const changes = historyChanges.length ? historyChanges : noteChanges;
            if (changes.length) {
                transformedOrder.items = changes.map((c) => ({
                    productId: {
                        _id: c.productId || null,
                        name: c.productName || 'Product',
                        slug: null,
                        images: []
                    },
                    variantId: c.variantId || null,
                    quantity: Number(c.oldQuantity) || 1,
                    priceSnapshot: {
                        base: null,
                        sale: null,
                        total: Number(c.amountRemovedInr) || 0
                    },
                    sku: null,
                    thumbnailUrl: null,
                    lineTotal: Number(c.amountRemovedInr) || 0,
                    unavailable: true,
                    lineStatus: 'cancelled_unavailable'
                }));
                // Restore money display from history `before` when totals were zeroed.
                const beforeSnap =
                    (transformedOrder.adminEditHistory || []).find((h) => h?.action === 'cancel_empty_after_edit')
                        ?.before || null;
                if (
                    beforeSnap &&
                    Number(transformedOrder.totalAmount) === 0 &&
                    Number(beforeSnap.totalAmount) > 0
                ) {
                    transformedOrder.subtotal = beforeSnap.subtotal;
                    transformedOrder.deliveryCharges = beforeSnap.deliveryCharges;
                    transformedOrder.tax = beforeSnap.tax;
                    transformedOrder.discount = beforeSnap.discount;
                    transformedOrder.totalAmount = beforeSnap.totalAmount;
                    transformedOrder._displayTotalsRestored = true;
                }
            }
        }

        transformedOrder.removedItemsArchive = Array.isArray(transformedOrder.removedItemsArchive)
            ? transformedOrder.removedItemsArchive.map((row) => ({
                  ...row,
                  lineTotal: Number(row?.priceSnapshot?.total) || 0,
                  unavailable: true,
                  lineStatus: 'removed'
              }))
            : [];

        // Hide internal admin audit from customer responses.
        if (!isOrderStaff) {
            delete transformedOrder.adminEditHistory;
            // Admin/RTO-only shipping split — never surface on customer order API.
            delete transformedOrder.deliveryFreightInr;
            delete transformedOrder.deliveryCodFeeInr;
        }

        if (isOrderStaff && transformedOrder.userId && typeof transformedOrder.userId === 'object') {
            transformedOrder.customer = {
                name: transformedOrder.userId.name || null,
                email: transformedOrder.userId.email || null,
                phone: transformedOrder.userId.phone || null
            };
            transformedOrder.userId = transformedOrder.userId._id;
        }

        if (isOrderStaff) {
            let snap = transformedOrder.shippingWeightSnapshot;
            if (!snap?.lines?.length && Array.isArray(order.items) && order.items.length) {
                const fallback = await buildShippingWeightSnapshotFromOrderItems(order);
                if (fallback) {
                    snap = fallback;
                    transformedOrder.shippingWeightSnapshot = fallback;
                }
            }
            if (snap?.lines?.length) {
                transformedOrder.shippingWeightSnapshot = await enrichShippingWeightSnapshotDims(snap);
            }
        }

        if (transformedOrder.returnInfo) {
            transformedOrder.returnInfo.windowDays = RETURN_REQUEST_WINDOW_DAYS;
        }

        const payload = {
            success: true,
            order: transformedOrder
        };
        if (isOrderStaff) {
            payload.fulfillmentPaymentGate = evaluateOrderPaymentForShiprocketFulfillment(order);
            const { buildShipmentOpsView } = require('../services/shipmentOps');
            transformedOrder.shipmentOps = buildShipmentOpsView(order, {
                fulfillmentPaymentGate: payload.fulfillmentPaymentGate,
                source: 'get_order'
            });
        }

        return res.json(payload);

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
                'orderId totalAmount orderStatus paymentStatus createdAt deliveryCharges tax subtotal paymentHoldExpiresAt balanceDueInr amountPaidInr paymentInfo customerFacingNotes'
            );
        const normalizedOrders = orders.map((doc) => {
            const plain = doc.toObject();
            normalizeTerminalUnpaidFinancials(plain);
            return plain;
        });

        return res.json({
            success: true,
            count: normalizedOrders.length,
            orders: normalizedOrders
        });

    } catch (error) {
        console.error('Get user orders error:', error);
        return respondOrderError(res, 500, 'USER_ORDERS_FETCH_FAILED', 'Error fetching orders', {
            error: error.message
        });
    }
};

// ========== CANCEL ORDER (DISABLED) ==========
// Intentionally commented: customer order cancellation removed by product policy — do not call accidentally.
// To restore: uncomment exports.cancelOrder below AND the route in routes/orders.route.js (`PUT /items/:orderId/cancel`).
/*
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

        const hasShiprocketAwb = Boolean(order.shipmentInfo?.awbCode || order.shipmentInfo?.trackingNumber);
        const hasScheduledPickup = Boolean(order.shipmentInfo?.pickupScheduledAt || order.shipmentInfo?.pickupDate);
        const terminalOrderStatuses = new Set(['shipped', 'out_for_delivery', 'delivered', 'cancelled', 'return_requested', 'payment_failed']);
        if (terminalOrderStatuses.has(String(order.orderStatus || '').toLowerCase())) {
            await session.abortTransaction();
            session.endSession();
            return respondOrderError(res, 400, 'ORDER_CANCELLATION_NOT_ALLOWED', `Order cannot be cancelled in ${order.orderStatus} status`);
        }
        const cancellableStatuses = ['pending', 'confirmed', 'processing'];
        if (!cancellableStatuses.includes(order.orderStatus)) {
            await session.abortTransaction();
            session.endSession();
            return respondOrderError(res, 400, 'ORDER_CANCELLATION_NOT_ALLOWED', `Order cannot be cancelled in ${order.orderStatus} status`);
        }
        if (hasShiprocketAwb || hasScheduledPickup) {
            await session.abortTransaction();
            session.endSession();
            return respondOrderError(
                res,
                400,
                'ORDER_CANCELLATION_NOT_ALLOWED',
                'Order cannot be cancelled after shipment AWB is assigned or pickup is scheduled. Contact support if needed.'
            );
        }

        const wasPaid = order.paymentStatus === 'paid';
        const canInitiateRefund = wasPaid && Boolean(order.paymentInfo?.razorpayPaymentId);

        order.orderStatus = 'cancelled';
        if (!wasPaid && String(order.paymentInfo?.method || '').toLowerCase() === 'online') {
            order.paymentStatus = 'failed';
        }
        normalizeTerminalUnpaidFinancials(order);
        order.paymentInfo = order.paymentInfo || {};
        order.paymentInfo.cancellationReason = 'user_cancelled';
        order.paymentInfo.cancelledAt = new Date();
        order.returnInfo = mergeReturnInfo(order.returnInfo, {
            refundContext: 'cancellation',
            status: canInitiateRefund ? 'refund_pending' : (wasPaid ? 'refund_unavailable' : 'not_required'),
            requestedAt: new Date(),
            refundAmount: canInitiateRefund ? order.totalAmount : (order.returnInfo?.refundAmount || 0)
        });
        order.markModified('paymentInfo');
        order.markModified('returnInfo');

        await order.save({ session });
        await releaseOrderStockHold(order, session);
        await order.save({ session });

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
                order.returnInfo = mergeReturnInfo(order.returnInfo, {
                    refundContext: 'cancellation',
                    refundAmount: order.totalAmount,
                    refundId: refund.id,
                    status: 'refunded',
                    approvedAt: new Date()
                });
                order.markModified('returnInfo');
                await order.save();
            } catch (refundError) {
                order.returnInfo = mergeReturnInfo(order.returnInfo, {
                    refundContext: 'cancellation',
                    status: 'refund_failed'
                });
                order.paymentInfo = {
                    ...(order.paymentInfo || {}),
                    refundFailureReason: refundError?.message || 'Refund API failed'
                };
                order.markModified('paymentInfo');
                order.markModified('returnInfo');
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
*/

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

        const order = await Order.findOne(mergeAdminOrderFilter(req, { orderId }));
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
            invoice: invoice,
            gstInvoice: buildGstInvoiceViewModel(order)
        });

    } catch (error) {
        console.error('Generate invoice error:', error);
        return respondOrderError(res, 500, 'INVOICE_GENERATION_FAILED', 'Error generating invoice', {
            error: error.message
        });
    }
};

function buildPaymentTimelineStep(order) {
    const ps = String(order.paymentStatus || '').toLowerCase();
    const method = String(order.paymentInfo?.method || '').toLowerCase();

    if (ps === 'paid') {
        return {
            status: 'Payment Confirmed',
            completed: true,
            timestamp: order.paymentInfo?.paidAt || order.updatedAt
        };
    }
    if (ps === 'partially_paid') {
        return {
            status: 'Advance paid (balance on delivery)',
            completed: true,
            timestamp: order.paymentInfo?.paidAt || order.updatedAt
        };
    }
    if (method === 'cod') {
        return {
            status: 'Pay on delivery (COD)',
            completed: false,
            timestamp: null
        };
    }
    if (ps === 'refunded' || ps === 'partially_refunded') {
        return {
            status: 'Payment refunded',
            completed: true,
            timestamp: order.updatedAt
        };
    }
    if (ps === 'failed') {
        return {
            status: 'Payment failed',
            completed: true,
            timestamp: order.updatedAt
        };
    }
    return { status: 'Payment Pending', completed: false, timestamp: null };
}

function buildDefaultOrderTimeline(order) {
    const placed = { status: 'Order Placed', completed: true, timestamp: order.createdAt };
    const payment = buildPaymentTimelineStep(order);

    const timeline = {
        pending: [placed, { ...payment, completed: payment.completed }],
        confirmed: [
            placed,
            payment,
            { status: 'Confirmed — preparing shipment', completed: true, timestamp: order.updatedAt },
            { status: 'Courier booking (Ship now)', completed: false, timestamp: null }
        ],
        processing: [
            placed,
            payment,
            {
                status: 'Processing — courier booked',
                completed: true,
                timestamp:
                    order.shipmentInfo?.awbAssignedAt ||
                    order.shipmentInfo?.shippedAt ||
                    order.updatedAt
            },
            { status: 'Shipped', completed: false, timestamp: null }
        ],
        shipped: [
            placed,
            payment,
            { status: 'Shipped', completed: true, timestamp: order.shipmentInfo?.shippedAt || null },
            { status: 'Out for Delivery', completed: false, timestamp: null }
        ],
        out_for_delivery: [
            placed,
            payment,
            { status: 'Shipped', completed: true, timestamp: order.shipmentInfo?.shippedAt || null },
            {
                status: 'Out for Delivery',
                completed: true,
                timestamp: order.shipmentInfo?.outForDeliveryAt || null
            },
            { status: 'Delivered', completed: false, timestamp: null }
        ],
        delivered: [
            placed,
            payment,
            { status: 'Shipped', completed: true, timestamp: order.shipmentInfo?.shippedAt || null },
            {
                status: 'Out for Delivery',
                completed: true,
                timestamp: order.shipmentInfo?.outForDeliveryAt || null
            },
            { status: 'Delivered', completed: true, timestamp: order.shipmentInfo?.deliveredAt || null }
        ],
        return_requested: [
            placed,
            payment,
            { status: 'Delivered', completed: true, timestamp: order.shipmentInfo?.deliveredAt || null },
            {
                status: 'Return requested',
                completed: true,
                timestamp: order.returnInfo?.requestedAt || order.updatedAt
            }
        ],
        cancelled: [
            placed,
            { status: 'Cancelled', completed: true, timestamp: order.paymentInfo?.cancelledAt || order.updatedAt }
        ],
        payment_failed: [
            placed,
            // Prefer paidAt when money captured but orderStatus was stuck (legacy bug / race).
            Number(order.amountPaidInr || 0) > 0.01 &&
            ['paid', 'partially_paid'].includes(String(order.paymentStatus || '').toLowerCase())
                ? {
                      status: 'Payment Confirmed',
                      completed: true,
                      timestamp: order.paymentInfo?.paidAt || order.updatedAt
                  }
                : { status: 'Payment failed', completed: true, timestamp: order.updatedAt }
        ]
    };

    const st = String(order.orderStatus || '').toLowerCase();
    if (timeline[st]) return timeline[st];
    if (['processing', 'shipped', 'out_for_delivery', 'delivered'].includes(st)) {
        return timeline.confirmed;
    }
    return timeline.pending;
}

function buildLiveTimelineFromEvents(events, fallbackTimeline) {
    if (!Array.isArray(events) || events.length === 0) {
        return fallbackTimeline;
    }
    const normalized = events
        .map((event) => ({
            status: event?.status || event?.description || 'Shipment Update',
            completed: true,
            timestamp: normalizeShipmentEventTimestamp(event?.at),
            location: event?.location || null,
            description: event?.description || null
        }))
        .filter((event) => Boolean(event.timestamp))
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    return normalized.length > 0 ? normalized : fallbackTimeline;
}

function enrichPreTransitTrackingTimeline(timeline, orderDoc) {
    if (!orderDoc || !Array.isArray(timeline)) return timeline;

    const { computeOpsState } = require('../services/shipmentOps/computeOpsState');
    const { OPS_STATES } = require('../services/shipmentOps/constants');
    const {
        isStaleCancelTimelineStatus,
        isForwardProgressStatus
    } = require('../services/shipmentOps/shiprocketStatusMap');
    const opsState = computeOpsState(orderDoc);
    const preInTransit = ![
        OPS_STATES.IN_TRANSIT,
        OPS_STATES.OUT_FOR_DELIVERY,
        OPS_STATES.DELIVERED,
        OPS_STATES.CANCELLED,
        OPS_STATES.PROVIDER_RESET,
        OPS_STATES.PAYMENT_FAILED
    ].includes(opsState);
    if (!preInTransit) return timeline;

    const si = orderDoc.shipmentInfo || {};
    const providerStatus = String(si.providerStatus || '').trim();
    if (!providerStatus) return timeline;

    const norm = (value) =>
        String(value || '')
            .trim()
            .toLowerCase()
            .replace(/[_-]+/g, ' ')
            .replace(/\s+/g, ' ');

    const providerNorm = norm(providerStatus);
    const hasCurrentStatus = timeline.some((event) => norm(event.status) === providerNorm);
    const onlyStaleCancel =
        timeline.length > 0 &&
        timeline.every((event) => isStaleCancelTimelineStatus(event.status || event.description));

    if (hasCurrentStatus && !onlyStaleCancel) {
        return timeline.filter((event) => !isStaleCancelTimelineStatus(event.status || event.description));
    }

    if (!isForwardProgressStatus(providerStatus, si.providerSnapshot?.statusCode)) {
        return timeline;
    }

    const filtered = timeline.filter(
        (event) => !isStaleCancelTimelineStatus(event.status || event.description)
    );
    const currentEvent = {
        status: providerStatus,
        completed: true,
        timestamp: si.lastSyncAt || new Date(),
        location: null,
        description:
            opsState === OPS_STATES.AWB_ASSIGNED ? 'Schedule pickup on Shiprocket to continue.' : null
    };
    return [...filtered, currentEvent].sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
}

// ========== TRACK ORDER ==========
exports.trackOrder = async (req, res) => {
    try {
        const { orderId } = req.params;
        let orderDoc = await Order.findOne({ orderId: orderId });

        if (!orderDoc) {
            return respondOrderError(res, 404, 'ORDER_NOT_FOUND', 'Order not found');
        }

        if (!canViewOrderForRequest(req, orderDoc, isOrderStaffRequest(req))) {
            return buildUnauthorizedOrderResponse(res);
        }

        const awbCode = orderDoc.shipmentInfo?.awbCode || orderDoc.shipmentInfo?.trackingNumber || null;
        const shipmentId = orderDoc.shipmentInfo?.shipmentId || null;
        let liveTracking = null;
        let trackingSource = 'internal';
        const provider = resolveOrderShippingProvider(orderDoc);

        // ——— Shipmozo: on-demand track + Case-1 RTO reconcile (no list polling / no Shiprocket APIs) ———
        if (provider === SHIPPING_PROVIDERS.SHIPMOZO) {
            if (awbCode) {
                const { reconcileOrderFromShipmozo } = require('../services/shipmozoReconcile.service');
                const reconcileResult = await reconcileOrderFromShipmozo(orderDoc, {
                    source: isOrderStaffRequest(req) ? 'admin_track_order_shipmozo' : 'track_order_shipmozo',
                    allowOrderStatusUpdate: true,
                    notify: true
                });
                if (reconcileResult.success) {
                    orderDoc = reconcileResult.order || (await Order.findOne({ orderId: orderDoc.orderId }));
                    trackingSource = 'shipmozo';
                    const trackingResult = reconcileResult.tracking;
                    if (trackingResult) {
                        const providerStatus =
                            orderDoc.shipmentInfo?.providerStatus ||
                            trackingResult.currentStatus ||
                            null;
                        liveTracking = {
                            ...trackingResult,
                            events: trackingResult.events || [],
                            currentStatus: providerStatus || trackingResult.currentStatus
                        };
                    }
                } else if (reconcileResult.message) {
                    logger.warn('Shipmozo live tracking fallback to internal timeline', {
                        orderId: orderDoc.orderId,
                        reason: reconcileResult.message,
                        code: reconcileResult.code
                    });
                }
            }
        } else if (awbCode || shipmentId || orderDoc.shipmentInfo?.shiprocketOrderId) {
            const { reconcileOrderFromShiprocket } = require('../services/shiprocketReconcile.service');
            const reconcileResult = await reconcileOrderFromShiprocket(orderDoc, {
                source: isOrderStaffRequest(req) ? 'admin_track_order' : 'track_order',
                mode: awbCode || shipmentId ? 'full' : 'forward',
                allowOrderStatusUpdate: true
            });
            if (reconcileResult.success) {
                orderDoc = reconcileResult.order || (await Order.findOne({ orderId: orderDoc.orderId }));
                trackingSource = 'shiprocket';
            }

            const trackAwb = orderDoc.shipmentInfo?.awbCode || orderDoc.shipmentInfo?.trackingNumber || awbCode;
            const trackShipmentId = orderDoc.shipmentInfo?.shipmentId || shipmentId;
            if (trackAwb || trackShipmentId) {
                const trackingResult = await ShiprocketService.getTracking({
                    awbCode: trackAwb,
                    shipmentId: trackShipmentId
                });
                if (trackingResult?.success) {
                    const { sanitizeTrackingEventsForProvider } = require('../services/shipmentOps/shiprocketStatusMap');
                    const providerStatus =
                        trackingResult.currentStatus || orderDoc.shipmentInfo?.providerStatus || null;
                    liveTracking = {
                        ...trackingResult,
                        events: sanitizeTrackingEventsForProvider(trackingResult.events, providerStatus),
                        currentStatus: providerStatus || trackingResult.currentStatus
                    };
                } else if (trackingResult?.message) {
                    logger.warn('Live tracking fallback to internal timeline', {
                        orderId: orderDoc.orderId,
                        reason: trackingResult.message
                    });
                }
            }
        }

        const fallbackTimeline = buildDefaultOrderTimeline(orderDoc);
        const rawTimeline = buildLiveTimelineFromEvents(liveTracking?.events, fallbackTimeline);

        const tracking = {
            orderId: orderDoc.orderId,
            currentStatus: orderDoc.orderStatus,
            trackingNumber: orderDoc.shipmentInfo?.trackingNumber || null,
            courier: orderDoc.shipmentInfo?.courier || null,
            estimatedDelivery: orderDoc.shipmentInfo?.estimatedDelivery || null,
            providerStatus: orderDoc.shipmentInfo?.providerStatus || null,
            lastSyncedAt: orderDoc.shipmentInfo?.lastSyncAt || null,
            source: trackingSource,
            shippingProvider: provider,
            timeline: enrichPreTransitTrackingTimeline(rawTimeline, orderDoc)
        };

        if (isOrderStaffRequest(req)) {
            const { buildShipmentOpsView } = require('../services/shipmentOps');
            tracking.shipmentOps = buildShipmentOpsView(orderDoc, { source: 'track_order' });
        } else {
            const { buildCustomerTrackingExtras } = require('../utils/customerTrackingDisplay');
            const hasAwb = Boolean(
                tracking.trackingNumber ||
                    orderDoc.shipmentInfo?.awbCode ||
                    orderDoc.shipmentInfo?.trackingNumber
            );
            const customerExtras = buildCustomerTrackingExtras({
                orderDoc,
                liveEvents: liveTracking?.events,
                hasAwb
            });
            tracking.simpleTimeline = fallbackTimeline;
            tracking.courierTimeline = customerExtras.courierTimeline;
            tracking.statusSummary = customerExtras.statusSummary;
        }

        return res.json({
            success: true,
            tracking
        });

    } catch (error) {
        console.error('Track order error:', error);
        return respondOrderError(res, 500, 'ORDER_TRACK_FAILED', 'Error tracking order', {
            error: error.message
        });
    }
};

exports.createReturnRequest = async (req, res) => {
    try {
        const { orderId } = req.params;
        const order = await Order.findOne({ orderId, userId: req.userId });
        if (!order) {
            return respondOrderError(res, 404, 'ORDER_NOT_FOUND', 'Order not found');
        }
        if (String(order.orderStatus || '').toLowerCase() !== 'delivered') {
            return respondOrderError(res, 400, 'RETURN_NOT_ELIGIBLE', 'Return request is allowed only for delivered orders');
        }
        const existingStatus = String(order.returnInfo?.status || '').toLowerCase();
        if (existingStatus && !['rejected', 'closed'].includes(existingStatus)) {
            return respondOrderError(res, 409, 'RETURN_REQUEST_EXISTS', 'Return request already exists for this order');
        }
        const windowEval = evaluateReturnRequestWindow(order);
        if (windowEval.enabled && !windowEval.skipped && windowEval.expired) {
            return respondOrderError(
                res,
                400,
                'RETURN_WINDOW_EXPIRED',
                `Return request window of ${windowEval.days} days has expired for this order`,
                {
                    deliveredAt: windowEval.deliveredAt.toISOString(),
                    returnLastDate: windowEval.deadlineAt.toISOString(),
                    returnWindowDays: windowEval.days
                }
            );
        }

        const reasonType = normalizeReturnReasonType(req.body?.reasonType);
        if (!reasonType) {
            return respondOrderError(res, 400, 'RETURN_REASON_INVALID', 'Return reason must be damaged or wrong_item');
        }
        const reasonMessage = normalizeReturnReasonMessage(req.body?.reasonMessage);
        if (!reasonMessage) {
            return respondOrderError(res, 400, 'RETURN_MESSAGE_REQUIRED', 'Please describe the issue');
        }

        const files = req.files || {};
        const proofVideo = Array.isArray(files.proofVideo) ? files.proofVideo[0] : null;
        const proofImages = Array.isArray(files.proofImages) ? files.proofImages : [];
        if (!proofVideo || proofImages.length === 0) {
            return respondOrderError(
                res,
                400,
                'RETURN_PROOF_REQUIRED',
                'Please upload one proof video and at least one proof image'
            );
        }

        if (!proofVideo.mimetype?.startsWith('video/')) {
            throw buildReturnProofUploadError('proofVideo must be a video file');
        }

        const uploads = [
            uploadReturnProofToCloudinary(proofVideo, order.orderId),
            ...proofImages.map((image) => uploadReturnProofToCloudinary(image, order.orderId))
        ];
        const proofs = await Promise.all(uploads);

        order.returnInfo = mergeReturnInfo(order.returnInfo, {
            refundContext: 'product_return',
            reasonType,
            reasonMessage,
            proofs,
            requestedAt: new Date(),
            approvedAt: null,
            approvedBy: null,
            rejectedAt: null,
            rejectedBy: null,
            decisionReason: null,
            status: 'requested',
            reverseShipmentId: null,
            reverseAwbCode: null,
            reverseTrackingNumber: null,
            reverseCourier: null,
            reverseProviderStatus: null,
            reverseEvents: [],
            reverseLastSyncAt: null,
            reverseLastError: null,
            refundInitiatedAt: null
        });
        order.orderStatus = 'return_requested';
        order.markModified('returnInfo');
        await order.save();

        return res.status(201).json({
            success: true,
            message: 'Return request submitted successfully',
            returnRequest: {
                orderId: order.orderId,
                status: order.returnInfo.status,
                reasonType: order.returnInfo.reasonType,
                requestedAt: order.returnInfo.requestedAt
            }
        });
    } catch (error) {
        logger.error('createReturnRequest failed', { message: error.message, stack: error.stack });
        const status = error.statusCode && Number.isFinite(error.statusCode) ? error.statusCode : 500;
        return respondOrderError(res, status, error.code || 'RETURN_REQUEST_FAILED', error.message || 'Could not create return request');
    }
};

exports.listAdminReturnRequests = async (req, res) => {
    try {
        const statusFilter = String(req.query?.status || '').trim().toLowerCase();
        const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '20'), 10) || 20));
        const skip = (page - 1) * limit;

        // Only customer product-return requests (not cancel / amendment refunds).
        const productReturnMatch = buildAdminProductReturnRequestMatch();
        const listFilter = statusFilter
            ? mergeAdminOrderFilter(req, {
                ...productReturnMatch,
                'returnInfo.status': statusFilter
              })
            : mergeAdminOrderFilter(req, productReturnMatch);

        const [rows, total] = await Promise.all([
            Order.find(listFilter)
                .sort({ 'returnInfo.requestedAt': -1 })
                .skip(skip)
                .limit(limit)
                .select('orderId totalAmount paymentStatus orderStatus returnInfo addressSnapshot createdAt updatedAt storefront userType')
                .lean(),
            Order.countDocuments(listFilter)
        ]);

        const data = rows.map((o) => ({
            orderId: o.orderId,
            createdAt: o.createdAt,
            updatedAt: o.updatedAt,
            totalAmount: o.totalAmount,
            paymentStatus: o.paymentStatus,
            orderStatus: o.orderStatus,
            customerName: o.addressSnapshot?.fullName || null,
            customerPhone: o.addressSnapshot?.phone || null,
            returnInfo: {
                status: o.returnInfo?.status || null,
                reasonType: o.returnInfo?.reasonType || null,
                refundContext: o.returnInfo?.refundContext || null,
                requestedAt: o.returnInfo?.requestedAt || null,
                approvedAt: o.returnInfo?.approvedAt || null,
                rejectedAt: o.returnInfo?.rejectedAt || null,
                reverseProviderStatus: o.returnInfo?.reverseProviderStatus || null
            }
        }));

        return res.json({
            success: true,
            data,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit) || 0,
                hasNextPage: page * limit < total,
                hasPrevPage: page > 1
            }
        });
    } catch (error) {
        logger.error('listAdminReturnRequests failed', { message: error.message, stack: error.stack });
        return respondOrderError(res, 500, 'RETURN_REQUEST_LIST_FAILED', 'Could not load return requests');
    }
};

exports.getAdminReturnRequest = async (req, res) => {
    try {
        const { orderId } = req.params;
        const order = await Order.findOne(mergeAdminOrderFilter(req, { orderId }))
            .populate('items.productId', 'name slug')
            .lean();
        if (!order) {
            return respondOrderError(res, 404, 'ORDER_NOT_FOUND', 'Order not found');
        }
        if (!isCustomerProductReturnRequest(order)) {
            return respondOrderError(res, 404, 'RETURN_REQUEST_NOT_FOUND', 'No customer product return request found for this order');
        }
        if (order.returnInfo) {
            order.returnInfo.windowDays = RETURN_REQUEST_WINDOW_DAYS;
        }
        return res.json({
            success: true,
            order
        });
    } catch (error) {
        logger.error('getAdminReturnRequest failed', { message: error.message, stack: error.stack });
        return respondOrderError(res, 500, 'RETURN_REQUEST_FETCH_FAILED', 'Could not load return request');
    }
};

exports.adminDecideReturnRequest = async (req, res) => {
    try {
        const { orderId } = req.params;
        const decision = String(req.body?.decision || '').trim().toLowerCase();
        const decisionReason = normalizeReturnReasonMessage(req.body?.decisionReason);
        if (!['approve', 'reject'].includes(decision)) {
            return respondOrderError(res, 400, 'RETURN_DECISION_INVALID', 'Decision must be approve or reject');
        }

        const order = await Order.findOne(mergeAdminOrderFilter(req, { orderId }));
        if (!order) {
            return respondOrderError(res, 404, 'ORDER_NOT_FOUND', 'Order not found');
        }
        if (!isCustomerProductReturnRequest(order)) {
            return respondOrderError(res, 404, 'RETURN_REQUEST_NOT_FOUND', 'No customer product return request found for this order');
        }
        if (String(order.returnInfo?.status || '').toLowerCase() !== 'requested') {
            return respondOrderError(res, 409, 'RETURN_DECISION_NOT_ALLOWED', 'Only requested returns can be reviewed');
        }

        if (decision === 'reject') {
            if (!decisionReason) {
                return respondOrderError(res, 400, 'RETURN_REJECT_REASON_REQUIRED', 'Please provide rejection reason');
            }
            order.returnInfo = mergeReturnInfo(order.returnInfo, {
                status: 'rejected',
                rejectedAt: new Date(),
                rejectedBy: req.userId || null,
                decisionReason
            });
            if (String(order.orderStatus || '').toLowerCase() === 'return_requested') {
                order.orderStatus = 'delivered';
            }
            order.markModified('returnInfo');
            await order.save();
            return res.json({ success: true, message: 'Return request rejected', orderId: order.orderId });
        }

        const reverse = isShipmozoOrder(order)
            ? await ShipmozoService.pushReturnOrder(order, order.returnInfo || {}, {
                returnReasonId: req.body?.returnReasonId,
                customerRequest: req.body?.customerRequest || 'REFUND'
              })
            : await ShiprocketService.createReturnPickup(order, order.returnInfo || {});
        if (!reverse?.success) {
            order.returnInfo = mergeReturnInfo(order.returnInfo, {
                status: 'approval_failed',
                reverseLastError: String(reverse?.error || 'Could not initiate reverse pickup')
            });
            order.markModified('returnInfo');
            await order.save();
            return respondOrderError(
                res,
                502,
                'REVERSE_PICKUP_CREATE_FAILED',
                'Return approved but reverse pickup initiation failed',
                { details: reverse?.error || null }
            );
        }

        order.returnInfo = mergeReturnInfo(order.returnInfo, {
            status: 'approved',
            approvedAt: new Date(),
            approvedBy: req.userId || null,
            decisionReason: decisionReason || null,
            reverseShipmentId: reverse.reverseShipmentId || null,
            reverseAwbCode: reverse.reverseAwbCode || null,
            reverseTrackingNumber: reverse.reverseTrackingNumber || null,
            reverseCourier: reverse.reverseCourier || null,
            reverseProviderStatus: reverse.providerStatus || 'reverse_pickup_created',
            reverseLastSyncAt: new Date(),
            reverseLastError: null
        });
        order.markModified('returnInfo');
        await order.save();

        return res.json({
            success: true,
            message: 'Return request approved and reverse pickup initiated',
            orderId: order.orderId
        });
    } catch (error) {
        logger.error('adminDecideReturnRequest failed', { message: error.message, stack: error.stack });
        return respondOrderError(res, 500, 'RETURN_DECISION_FAILED', 'Could not process return decision');
    }
};

exports.adminInitiateReturnRefund = async (req, res) => {
    try {
        const { orderId } = req.params;
        const order = await Order.findOne(mergeAdminOrderFilter(req, { orderId }));
        if (!order) {
            return respondOrderError(res, 404, 'ORDER_NOT_FOUND', 'Order not found');
        }
        if (!isCustomerProductReturnRequest(order)) {
            return respondOrderError(res, 404, 'RETURN_REQUEST_NOT_FOUND', 'No customer product return request found for this order');
        }
        if (!isReturnRefundEligible(order)) {
            return respondOrderError(
                res,
                409,
                'RETURN_REFUND_NOT_ELIGIBLE',
                'Refund can be initiated only after return is received/QC passed'
            );
        }
        if (String(order.paymentInfo?.method || '').toLowerCase() !== 'online') {
            return respondOrderError(
                res,
                400,
                'RETURN_REFUND_NON_ONLINE',
                'Automatic refund is available only for online payments'
            );
        }
        if (!order.paymentInfo?.razorpayPaymentId) {
            return respondOrderError(res, 400, 'RAZORPAY_PAYMENT_MISSING', 'No Razorpay payment found on this order');
        }
        if (!['paid', 'partially_refunded'].includes(String(order.paymentStatus || '').toLowerCase())) {
            return respondOrderError(res, 400, 'ORDER_NOT_REFUNDABLE', 'Order is not in refundable payment state');
        }

        const alreadyRefundedInr = roundMoney2(
            (order.refundHistory || []).reduce((s, r) => s + (Number(r.amountInr) || 0), 0)
        );
        const remainingInr = roundMoney2(order.totalAmount - alreadyRefundedInr);
        if (remainingInr <= 0) {
            return respondOrderError(res, 400, 'REFUND_NOTHING_PENDING', 'Nothing left to refund');
        }

        const refund = await razorpay.payments.refund(order.paymentInfo.razorpayPaymentId, {
            amount: Math.round(remainingInr * 100),
            speed: 'normal',
            notes: {
                orderId: order.orderId,
                reason: 'return_received_refund'
            }
        });

        await applyRefundEntryToOrder(order, refund);
        order.returnInfo = mergeReturnInfo(order.returnInfo, {
            status: 'refunded',
            refundInitiatedAt: new Date(),
            refundAmount: remainingInr,
            refundId: refund.id
        });
        order.markModified('returnInfo');
        await order.save();

        return res.json({
            success: true,
            message: 'Refund initiated successfully',
            orderId: order.orderId,
            refund: {
                id: refund.id,
                amountInr: remainingInr,
                status: refund.status
            }
        });
    } catch (error) {
        logger.error('adminInitiateReturnRefund failed', { message: error.message, stack: error.stack });
        return respondOrderError(
            res,
            500,
            'RETURN_REFUND_INIT_FAILED',
            error.error?.description || error.message || 'Could not initiate refund'
        );
    }
};

// ========== ADMIN: REFUND (full or partial, server-validated) ==========
exports.refundOrderPayment = async (req, res) => {
    try {
        const { orderId } = req.params;
        const { amount } = req.body || {};

        const order = await Order.findOne(mergeAdminOrderFilter(req, { orderId }));
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

// ========== RETURN CHAT SUPPORT ==========
exports.sendReturnChatMessage = async (req, res) => {
    try {
        const { orderId } = req.params;
        const { message } = req.body;
        const isAdmin = req.userRole === 'admin' || req.userRole === 'order_manager';

        if (!message || !message.trim()) {
            return respondOrderError(res, 400, 'MESSAGE_REQUIRED', 'Message content is required');
        }

        const query = isAdmin
            ? mergeAdminOrderFilter(req, { orderId })
            : { orderId, userId: req.userId };
        const order = await Order.findOne(query);

        if (!order) {
            return respondOrderError(res, 404, 'ORDER_NOT_FOUND', 'Order not found');
        }

        if (!isCustomerProductReturnRequest(order)) {
            return respondOrderError(
                res,
                400,
                'RETURN_NOT_REQUESTED',
                'Chat is only available for customer product return requests'
            );
        }

        const requestedAt = order.returnInfo?.requestedAt;
        const windowDays = Number(RETURN_REQUEST_WINDOW_DAYS) || 2;
        const deadlineAt = new Date(new Date(requestedAt).getTime() + windowDays * 24 * 60 * 60 * 1000);
        const isExpired = new Date() > deadlineAt;

        if (isExpired) {
            return respondOrderError(res, 403, 'CHAT_WINDOW_EXPIRED', `Support chat window of ${windowDays} days has expired`);
        }

        const sender = isAdmin ? 'admin' : 'user';

        if (!order.returnInfo.chat) {
            order.returnInfo.chat = [];
        }

        order.returnInfo.chat.push({
            sender,
            message: message.trim(),
            createdAt: new Date()
        });

        if (isAdmin) {
            order.returnInfo.adminLastRead = new Date();
        } else {
            order.returnInfo.userLastRead = new Date();
        }

        order.markModified('returnInfo');
        await order.save();

        return res.json({
            success: true,
            chat: order.returnInfo.chat,
            userLastRead: order.returnInfo.userLastRead,
            adminLastRead: order.returnInfo.adminLastRead,
            chatWindowDeadline: deadlineAt.toISOString(),
            isChatActive: !isExpired
        });
    } catch (error) {
        logger.error('sendReturnChatMessage failed', { message: error.message, stack: error.stack });
        return respondOrderError(res, 500, 'SEND_CHAT_FAILED', 'Could not send chat message');
    }
};

exports.getReturnChat = async (req, res) => {
    try {
        const { orderId } = req.params;
        const isAdmin = req.userRole === 'admin' || req.userRole === 'order_manager';

        const query = isAdmin
            ? mergeAdminOrderFilter(req, { orderId })
            : { orderId, userId: req.userId };
        const order = await Order.findOne(query);

        if (!order) {
            return respondOrderError(res, 404, 'ORDER_NOT_FOUND', 'Order not found');
        }

        if (!isCustomerProductReturnRequest(order)) {
            return respondOrderError(
                res,
                400,
                'RETURN_NOT_REQUESTED',
                'Chat is only available for customer product return requests'
            );
        }

        if (order.returnInfo) {
            if (isAdmin) {
                order.returnInfo.adminLastRead = new Date();
            } else {
                order.returnInfo.userLastRead = new Date();
            }
            order.markModified('returnInfo');
            await order.save();
        }

        const requestedAt = order.returnInfo?.requestedAt;
        const windowDays = Number(RETURN_REQUEST_WINDOW_DAYS) || 2;
        const deadlineAt = requestedAt ? new Date(new Date(requestedAt).getTime() + windowDays * 24 * 60 * 60 * 1000) : null;
        const isExpired = deadlineAt ? (new Date() > deadlineAt) : true;

        return res.json({
            success: true,
            chat: order.returnInfo?.chat || [],
            userLastRead: order.returnInfo?.userLastRead,
            adminLastRead: order.returnInfo?.adminLastRead,
            chatWindowDeadline: deadlineAt ? deadlineAt.toISOString() : null,
            isChatActive: requestedAt ? !isExpired : false
        });
    } catch (error) {
        logger.error('getReturnChat failed', { message: error.message, stack: error.stack });
        return respondOrderError(res, 500, 'GET_CHAT_FAILED', 'Could not fetch chat history');
    }
};

/** Used by admin fulfillment controller — keeps shipment sync logic single-sourced. */
exports.applyUpsertShipmentInfo = upsertShipmentInfo;
exports.ensureShipmentForOrderExport = ensureShipmentForOrder;