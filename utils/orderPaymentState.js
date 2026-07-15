/**
 * Payment ↔ orderStatus consistency helpers.
 *
 * Intermediate Razorpay attempts can fail while the customer still completes checkout
 * (retries / delayed webhooks). Never leave money-captured orders stuck in
 * payment_failed / cancelled-from-unpaid-automation.
 */

const { isLegacyAutoFulfillOnCheckout } = require('../constants/orderFulfillmentAutomation');

const MONEY_CAPTURED_PAYMENT_STATUSES = new Set(['paid', 'partially_paid']);

/** Order statuses that mean "unpaid checkout died" and may be healed after capture. */
const RECOVERABLE_AFTER_CAPTURE_ORDER_STATUSES = new Set(['payment_failed', 'cancelled']);

/** Auto-cancel reasons that are safe to reverse when money actually captured. */
const RECOVERABLE_CANCEL_REASONS = new Set([
  'checkout_gateway_dismissed',
  'payment_timeout'
]);

function normalizeLower(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function isMoneyCapturedPaymentStatus(paymentStatus) {
  return MONEY_CAPTURED_PAYMENT_STATUSES.has(normalizeLower(paymentStatus));
}

/**
 * Target orderStatus after a successful capture under current fulfilment policy.
 * Default (legacy off): stay/return to pending for the admin approval queue.
 */
function targetOrderStatusAfterSuccessfulCapture() {
  return isLegacyAutoFulfillOnCheckout() ? 'confirmed' : 'pending';
}

function canRecoverCancelledOrderAfterCapture(order) {
  const reason = normalizeLower(order?.paymentInfo?.cancellationReason);
  return RECOVERABLE_CANCEL_REASONS.has(reason);
}

/**
 * True when orderStatus looks terminal-unpaid AND no money was captured.
 * Used by ops/UI so paid+payment_failed does not block fulfilment.
 */
function isUnpaidTerminalOrder(order) {
  if (!order) return false;
  const orderStatus = normalizeLower(order.orderStatus);
  if (!RECOVERABLE_AFTER_CAPTURE_ORDER_STATUSES.has(orderStatus)) {
    return false;
  }
  if (isMoneyCapturedPaymentStatus(order.paymentStatus) && Number(order.amountPaidInr || 0) > 0.01) {
    if (orderStatus === 'cancelled' && !canRecoverCancelledOrderAfterCapture(order)) {
      // Intentional cancel after pay (admin / customer) — still terminal for forward ship.
      return true;
    }
    return false;
  }
  return true;
}

/**
 * If payment settled but orderStatus is still an unpaid-terminal label, heal it.
 * Safe / idempotent — returns whether mutation happened.
 *
 * @param {import('mongoose').Document | object} order
 * @param {{ trigger?: string }} [opts]
 * @returns {{ changed: boolean, previousOrderStatus: string|null, nextOrderStatus: string|null, reason: string|null }}
 */
function recoverOrderStatusAfterSuccessfulCapture(order, opts = {}) {
  if (!order) {
    return { changed: false, previousOrderStatus: null, nextOrderStatus: null, reason: null };
  }

  const paymentStatus = normalizeLower(order.paymentStatus);
  if (!isMoneyCapturedPaymentStatus(paymentStatus)) {
    return {
      changed: false,
      previousOrderStatus: normalizeLower(order.orderStatus) || null,
      nextOrderStatus: null,
      reason: null
    };
  }

  const paid = Number(order.amountPaidInr || 0);
  if (!(paid > 0.01)) {
    return {
      changed: false,
      previousOrderStatus: normalizeLower(order.orderStatus) || null,
      nextOrderStatus: null,
      reason: null
    };
  }

  const previousOrderStatus = normalizeLower(order.orderStatus);
  if (!RECOVERABLE_AFTER_CAPTURE_ORDER_STATUSES.has(previousOrderStatus)) {
    // Still promote pending → confirmed when legacy auto-fulfill is on.
    if (isLegacyAutoFulfillOnCheckout() && previousOrderStatus === 'pending') {
      order.orderStatus = 'confirmed';
      return {
        changed: true,
        previousOrderStatus,
        nextOrderStatus: 'confirmed',
        reason: opts.trigger || 'legacy_confirm_after_capture'
      };
    }
    return {
      changed: false,
      previousOrderStatus,
      nextOrderStatus: null,
      reason: null
    };
  }

  if (previousOrderStatus === 'cancelled' && !canRecoverCancelledOrderAfterCapture(order)) {
    return {
      changed: false,
      previousOrderStatus,
      nextOrderStatus: null,
      reason: null
    };
  }

  const nextOrderStatus = targetOrderStatusAfterSuccessfulCapture();
  order.orderStatus = nextOrderStatus;

  order.paymentInfo = order.paymentInfo || {};
  // Keep audit of the failed attempt but clear the top-level "failed" gateway status.
  if (normalizeLower(order.paymentInfo.status) === 'failed' || normalizeLower(order.paymentInfo.status) === 'expired') {
    order.paymentInfo.status = 'success';
  }
  if (normalizeLower(order.paymentInfo.status) === 'abandoned') {
    order.paymentInfo.status = 'success';
  }
  if (previousOrderStatus === 'cancelled') {
    order.paymentInfo.recoveredFromCancellationReason = order.paymentInfo.cancellationReason || null;
    order.paymentInfo.cancellationReason = null;
    order.paymentInfo.cancelledAt = null;
  }
  order.paymentInfo.recoveredFromOrderStatus = previousOrderStatus;
  order.paymentInfo.orderStatusRecoveredAt = new Date();
  order.paymentInfo.orderStatusRecoveredTrigger = opts.trigger || 'successful_capture';

  if (typeof order.markModified === 'function') {
    order.markModified('paymentInfo');
  }

  return {
    changed: true,
    previousOrderStatus,
    nextOrderStatus,
    reason: opts.trigger || 'successful_capture'
  };
}

/**
 * Record a failed Razorpay payment attempt without terminalizing the whole checkout.
 * Inventory stays reserved until abandon / payment-hold expiry / explicit cancel.
 *
 * @param {import('mongoose').Document | object} order
 * @param {{ order_id?: string, id?: string, error_description?: string, error_code?: string }} failedPayment
 * @returns {{ changed: boolean }}
 */
function recordOnlinePaymentAttemptFailure(order, failedPayment) {
  if (!order) return { changed: false };

  const paymentStatus = normalizeLower(order.paymentStatus);
  // Never clobber settled / refunded money state from a late failed webhook.
  if (isMoneyCapturedPaymentStatus(paymentStatus) || ['refunded', 'partially_refunded'].includes(paymentStatus)) {
    return { changed: false };
  }

  if (Number(order.amountPaidInr || 0) > 0.01) {
    return { changed: false };
  }

  order.paymentInfo = order.paymentInfo || {};
  const reason =
    failedPayment?.error_description || failedPayment?.error_code || 'Payment attempt failed';
  const code = failedPayment?.error_code || '';
  const rzOrderId = failedPayment?.order_id || null;
  const rzPaymentId = failedPayment?.id || null;
  const now = new Date();

  order.paymentInfo.lastFailureReason = reason;
  order.paymentInfo.lastFailureCode = code;
  order.paymentInfo.lastFailedAt = now;
  if (rzOrderId) order.paymentInfo.lastFailedRazorpayOrderId = rzOrderId;
  if (rzPaymentId) order.paymentInfo.lastFailedRazorpayPaymentId = rzPaymentId;

  if (Array.isArray(order.paymentInfo.sessions) && rzOrderId) {
    const session = order.paymentInfo.sessions.find((s) => s.razorpayOrderId === rzOrderId);
    if (session && normalizeLower(session.status) !== 'paid') {
      session.status = 'failed';
      session.failureReason = reason;
      session.failureCode = code;
      session.failedAt = now;
      if (rzPaymentId) session.razorpayPaymentId = rzPaymentId;
    }
  }

  // Leave orderStatus / paymentStatus as pending so retries (same or new session) work.
  // Do not set paymentInfo.status = 'failed' at the order root — that confuses admin vs paid recovery.
  if (typeof order.markModified === 'function') {
    order.markModified('paymentInfo');
  }

  return { changed: true };
}

module.exports = {
  MONEY_CAPTURED_PAYMENT_STATUSES,
  RECOVERABLE_AFTER_CAPTURE_ORDER_STATUSES,
  RECOVERABLE_CANCEL_REASONS,
  isMoneyCapturedPaymentStatus,
  isUnpaidTerminalOrder,
  targetOrderStatusAfterSuccessfulCapture,
  recoverOrderStatusAfterSuccessfulCapture,
  recordOnlinePaymentAttemptFailure
};
