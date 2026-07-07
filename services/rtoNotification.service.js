/**
 * RTO customer in-app notifications — idempotent, driven by Shiprocket + Razorpay events.
 * Reuses rtoRefund.service eligibility; does not alter order/refund logic.
 */
const UserNotification = require('../models/UserNotification');
const Order = require('../models/Order');
const logger = require('../utils/logger');
const { roundMoney2 } = require('./checkoutComputation.service');
const { getRtoRefundPolicyUrl } = require('../config/rtoNotification.config');
const { isRtoProviderStatus } = require('./shipmentOps/shiprocketStatusMap');
const {
  calculateRtoRefund,
  classifyRtoPaymentType,
  getRtoOrderTotal,
  getMinRefundThreshold
} = require('./rtoRefund.service');

function formatInrDisplay(amount) {
  const n = roundMoney2(Number(amount) || 0);
  return n % 1 === 0 ? String(Math.round(n)) : n.toFixed(2);
}

function isRtoOrder(order) {
  if (!order) return false;
  if (String(order.orderStatus || '').toLowerCase() === 'rto') return true;
  return isRtoProviderStatus(order.shipmentInfo?.providerStatus);
}

function wasOrderInRtoState(order) {
  return isRtoOrder(order);
}

function isRtoRelatedRefund(order, refundEntity) {
  const noteReason = String(refundEntity?.notes?.reason || '').toLowerCase();
  if (noteReason.includes('rto')) return true;
  const ri = order?.returnInfo || {};
  if (ri.rtoRefundId || ri.rtoStatus || ri.refundInitiatedAt) return true;
  return isRtoOrder(order);
}

/**
 * @param {import('mongoose').Document|object} order
 */
function buildRtoInitiatedPayload(order) {
  const orderId = String(order.orderId || '').trim();
  const policyUrl = getRtoRefundPolicyUrl();
  const pay = classifyRtoPaymentType(order);
  const calc = calculateRtoRefund(order);
  const orderTotal = getRtoOrderTotal(order);

  if (pay.key === 'cod') {
    return {
      type: 'refund_not_applicable',
      title: 'Order Returned - Refund Not Applicable',
      body:
        `Your order #${orderId} has been returned. Since this was a COD order, no refund is applicable as no payment was collected online. Please read our refund policy for more details: ${policyUrl}`,
      metadata: { reason: 'cod', orderTotal, policyUrl }
    };
  }

  if (pay.key === 'partial_paid') {
    return {
      type: 'refund_not_applicable',
      title: 'Order Returned - Refund Not Applicable',
      body:
        `Your order #${orderId} has been returned. Since this was a partial payment order, refund is not applicable as per our RTO policy. Please read our refund policy for more details: ${policyUrl}`,
      metadata: { reason: 'partial_payment', orderTotal, policyUrl }
    };
  }

  if (calc.reason === 'order_below_min_value') {
    return {
      type: 'refund_not_applicable',
      title: 'Order Returned - Refund Not Applicable',
      body:
        `Your order #${orderId} of ₹${formatInrDisplay(orderTotal)} has been returned. As per policy, refund is not applicable for orders below ₹100. Please read our refund policy for more details: ${policyUrl}`,
      metadata: { reason: 'order_below_min_value', orderTotal, policyUrl }
    };
  }

  if (calc.reason === 'refund_below_min_threshold') {
    const minThreshold = getMinRefundThreshold();
    return {
      type: 'refund_not_applicable',
      title: 'Order Returned - Refund Not Applicable',
      body:
        `Your order #${orderId} has been returned. The calculated refund (₹${formatInrDisplay(calc.netRefund)}) is below our minimum refund threshold of ₹${formatInrDisplay(minThreshold)}. Please read our refund policy for more details: ${policyUrl}`,
      metadata: {
        reason: 'refund_below_min_threshold',
        orderTotal,
        refundAmount: calc.netRefund,
        policyUrl
      }
    };
  }

  if (calc.eligible) {
    return {
      type: 'rto_initiated',
      title: 'Order Return Initiated',
      body:
        `Your order #${orderId} has been returned to origin (RTO). Once we receive and fully verify the return at our warehouse, and your case is approved, your refund will be processed. We will notify you at each step.`,
      metadata: { reason: 'eligible_full_paid', orderTotal, refundAmount: calc.netRefund, policyUrl }
    };
  }

  return {
    type: 'refund_not_applicable',
    title: 'Order Returned - Refund Not Applicable',
    body:
      `Your order #${orderId} has been returned. Refund is not applicable as per our RTO policy. Please read our refund policy for more details: ${policyUrl}`,
    metadata: { reason: calc.reason || 'not_eligible', orderTotal, policyUrl }
  };
}

function buildRefundInitiatedPayload(order, amountInr) {
  const orderId = String(order.orderId || '').trim();
  const amount = roundMoney2(amountInr);
  return {
    type: 'refund_initiated',
    title: 'Refund Initiated',
    body:
      `Your refund of ₹${formatInrDisplay(amount)} for order #${orderId} has been initiated. The amount should reflect in your account within 5-7 working days.`,
    metadata: { reason: 'refund_initiated', refundAmount: amount, orderTotal: getRtoOrderTotal(order) }
  };
}

function buildRefundProcessedPayload(order, amountInr) {
  const orderId = String(order.orderId || '').trim();
  const amount = roundMoney2(amountInr);
  return {
    type: 'refund_processed',
    title: 'Refund Processed',
    body:
      `Refund of ₹${formatInrDisplay(amount)} for order #${orderId} has been processed successfully. The amount should reflect in your account within 5-7 working days.`,
    metadata: { reason: 'refund_processed', refundAmount: amount, orderTotal: getRtoOrderTotal(order) }
  };
}

function buildRefundRejectedByAdminPayload(order, options = {}) {
  const orderId = String(order.orderId || '').trim();
  const policyUrl = getRtoRefundPolicyUrl();
  const isNoRefundCase = Boolean(options.isNoRefundCase);

  if (isNoRefundCase) {
    return {
      type: 'refund_rejected',
      title: 'RTO Case Closed',
      body:
        `Your RTO case for order #${orderId} has been closed. No refund will be processed. For details, read our refund policy: ${policyUrl}`,
      metadata: { reason: 'case_closed_no_refund', orderTotal: getRtoOrderTotal(order), policyUrl }
    };
  }

  return {
    type: 'refund_rejected',
    title: 'Refund Cancelled',
    body:
      `Refund for order #${orderId} has been cancelled. The return reason did not satisfy our refund policy requirements. No refund will be processed. For details: ${policyUrl}`,
    metadata: { reason: 'admin_denied_refund', orderTotal: getRtoOrderTotal(order), policyUrl }
  };
}

function buildRefundFailedPayload(order) {
  const orderId = String(order.orderId || '').trim();
  const policyUrl = getRtoRefundPolicyUrl();
  return {
    type: 'refund_failed',
    title: 'Refund Failed',
    body:
      `We could not process the refund for order #${orderId}. Our team will review this issue. For help, contact support or read our policy: ${policyUrl}`,
    metadata: { reason: 'refund_failed', policyUrl }
  };
}

/**
 * @param {object} payload
 * @returns {Promise<{ created: boolean, notification: object|null }>}
 */
async function createNotificationIdempotent(payload) {
  if (!payload?.userId || !payload?.orderId || !payload?.type) {
    return { created: false, notification: null };
  }

  try {
    const notification = await UserNotification.create({
      userId: payload.userId,
      orderId: payload.orderId,
      type: payload.type,
      title: payload.title,
      body: payload.body,
      read: false,
      sentAt: new Date(),
      metadata: payload.metadata || {}
    });
    return { created: true, notification };
  } catch (err) {
    if (err && err.code === 11000) {
      return { created: false, notification: null };
    }
    throw err;
  }
}

/**
 * @param {import('mongoose').Document|object} order
 */
async function notifyRtoInitiated(order) {
  if (!order?.userId || !order?.orderId) return { created: false };
  if (!isRtoOrder(order)) return { created: false };

  const content = buildRtoInitiatedPayload(order);
  const result = await createNotificationIdempotent({
    userId: order.userId,
    orderId: order.orderId,
    ...content
  });

  if (result.created) {
    logger.info('[rtoNotification] RTO initiate notification created', {
      orderId: order.orderId,
      type: content.type,
      userId: String(order.userId)
    });
  }
  return result;
}

/**
 * @param {import('mongoose').Document|object} order
 * @param {number} amountInr
 */
async function notifyRefundInitiated(order, amountInr) {
  if (!order?.userId || !order?.orderId) return { created: false };
  if (!isRtoOrder(order)) return { created: false };

  const content = buildRefundInitiatedPayload(order, amountInr);
  const result = await createNotificationIdempotent({
    userId: order.userId,
    orderId: order.orderId,
    ...content
  });

  if (result.created) {
    logger.info('[rtoNotification] Refund initiated notification created', {
      orderId: order.orderId,
      amountInr: roundMoney2(amountInr),
      userId: String(order.userId)
    });
  }
  return result;
}

/**
 * @param {import('mongoose').Document|object} order
 * @param {number} amountInr
 */
async function notifyRefundProcessed(order, amountInr) {
  if (!order?.userId || !order?.orderId) return { created: false };
  if (!isRtoRelatedRefund(order, { notes: { reason: 'rto_refund' } })) return { created: false };

  const content = buildRefundProcessedPayload(order, amountInr);
  const result = await createNotificationIdempotent({
    userId: order.userId,
    orderId: order.orderId,
    ...content
  });

  if (result.created) {
    logger.info('[rtoNotification] Refund processed notification created', {
      orderId: order.orderId,
      amountInr: roundMoney2(amountInr),
      userId: String(order.userId)
    });
  }
  return result;
}

/**
 * Admin denied refund or closed case (Deny / Close case button).
 * @param {import('mongoose').Document|object} order
 * @param {{ isNoRefundCase?: boolean }} [options]
 */
async function notifyRefundRejectedByAdmin(order, options = {}) {
  if (!order?.userId || !order?.orderId) return { created: false };
  if (!isRtoOrder(order)) return { created: false };

  const content = buildRefundRejectedByAdminPayload(order, options);
  const result = await createNotificationIdempotent({
    userId: order.userId,
    orderId: order.orderId,
    ...content
  });

  if (result.created) {
    logger.info('[rtoNotification] Refund rejected/closed notification created', {
      orderId: order.orderId,
      isNoRefundCase: Boolean(options.isNoRefundCase),
      userId: String(order.userId)
    });
  }
  return result;
}

/**
 * @param {import('mongoose').Document|object} order
 */
async function notifyRefundFailed(order) {
  if (!order?.userId || !order?.orderId) return { created: false };
  if (!isRtoOrder(order)) return { created: false };

  const content = buildRefundFailedPayload(order);
  const result = await createNotificationIdempotent({
    userId: order.userId,
    orderId: order.orderId,
    ...content
  });

  if (result.created) {
    logger.info('[rtoNotification] Refund failed notification created', {
      orderId: order.orderId,
      userId: String(order.userId)
    });
  }
  return result;
}

/**
 * Called after Shiprocket webhook persists shipment update.
 * @param {{ orderId: string, previousProviderStatus?: string|null, previousOrderStatus?: string|null }} ctx
 */
async function handleShiprocketWebhookForRtoNotifications(ctx) {
  const orderId = String(ctx?.orderId || '').trim();
  if (!orderId) return;

  const order = await Order.findOne({ orderId }).lean(false);
  if (!order) return;

  const previousRto = wasOrderInRtoState({
    orderStatus: ctx.previousOrderStatus,
    shipmentInfo: { providerStatus: ctx.previousProviderStatus }
  });

  if (previousRto || !isRtoOrder(order)) return;

  await notifyRtoInitiated(order);
}

/**
 * @param {import('mongoose').Document|object} order
 * @param {object} refundEntity Razorpay refund entity
 * @param {string} eventName
 */
async function handleRazorpayRefundForRtoNotifications(order, refundEntity, eventName) {
  if (!order) return;

  const fresh = await Order.findOne({ orderId: order.orderId });
  if (!fresh) return;

  const event = String(eventName || '').toLowerCase();
  const status = String(refundEntity?.status || '').toLowerCase();

  if (event === 'refund.failed' || status === 'failed') {
    if (isRtoRelatedRefund(fresh, refundEntity)) {
      await notifyRefundFailed(fresh);
    }
    return;
  }

  if (event !== 'refund.processed' && status !== 'processed') {
    return;
  }

  if (!isRtoRelatedRefund(fresh, refundEntity)) return;

  const amountPaise = Number(refundEntity?.amount);
  if (!Number.isFinite(amountPaise) || amountPaise <= 0) return;

  await notifyRefundProcessed(fresh, roundMoney2(amountPaise / 100));
}

module.exports = {
  isRtoOrder,
  buildRtoInitiatedPayload,
  buildRefundInitiatedPayload,
  buildRefundRejectedByAdminPayload,
  createNotificationIdempotent,
  notifyRtoInitiated,
  notifyRefundInitiated,
  notifyRefundProcessed,
  notifyRefundRejectedByAdmin,
  notifyRefundFailed,
  handleShiprocketWebhookForRtoNotifications,
  handleRazorpayRefundForRtoNotifications
};
