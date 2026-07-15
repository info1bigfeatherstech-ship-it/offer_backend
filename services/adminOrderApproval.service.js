/**
 * Admin approval workflow (Phase 2): confirm pending orders for fulfilment, or cancel and restore stock.
 * Inventory is adjusted only at checkout (reserve) and on admin cancel (release) — never on confirm.
 */

const mongoose = require('mongoose');
const Razorpay = require('razorpay');
const Order = require('../models/Order');
const logger = require('../utils/logger');
const { releaseReservedInventoryForOrder } = require('./orderInventory.service');
const { evaluateOrderPaymentForShiprocketFulfillment } = require('../utils/orderFulfillmentPaymentGate');
const { ensureShipmentForOrderExport } = require('../controllers/order.controller');
const { mergeReturnInfo } = require('./rtoRefund.service');
const { mergeOrderScopeFilter } = require('../utils/adminOrderScope');

const FULFILLMENT_ITEM_POPULATE = { path: 'items.productId', select: 'name slug shipping' };

const razorpay =
  String(process.env.RAZORPAY_KEY_ID || '').trim() && String(process.env.RAZORPAY_KEY_SECRET || '').trim()
    ? new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET
      })
    : null;

/**
 * @param {import('mongoose').Document} order
 */
function normalizeTerminalUnpaidFinancials(order) {
  const method = String(order.paymentInfo?.method || '').toLowerCase();
  if (method === 'online' && order.paymentStatus !== 'paid' && order.paymentStatus !== 'partially_paid') {
    order.balanceDueInr = 0;
    order.amountPaidInr = Number(order.amountPaidInr) || 0;
  }
}

/**
 * @param {import('mongoose').Document|object} order
 * @returns {number}
 */
function getCancelledOrderRefundAmount(order) {
  const paymentStatus = String(order?.paymentStatus || '').toLowerCase();
  if (paymentStatus === 'partially_paid') {
    return Math.max(0, Number(order?.amountPaidInr) || 0);
  }
  if (paymentStatus === 'paid') {
    return Math.max(0, Number(order?.totalAmount) || 0);
  }
  return 0;
}

/**
 * @param {import('mongoose').Document} order
 * @param {{ reason?: string }} [opts]
 */
async function attemptRefundForCancelledPaidOrder(order, opts = {}) {
  const paymentStatus = String(order.paymentStatus || '').toLowerCase();
  const wasPaid = paymentStatus === 'paid' || paymentStatus === 'partially_paid';
  const paymentId = order.paymentInfo?.razorpayPaymentId;
  if (!wasPaid || !paymentId || !razorpay) {
    return { refundAttempted: false, refundWarning: null };
  }

  const refundAmountInr = getCancelledOrderRefundAmount(order);
  const refundPaise = Math.round(refundAmountInr * 100);
  if (refundPaise < 1) {
    return { refundAttempted: false, refundWarning: null };
  }

  try {
    const refund = await razorpay.payments.refund(paymentId, {
      amount: refundPaise,
      notes: {
        orderId: order.orderId,
        reason: opts.reason || 'Order cancelled by admin'
      }
    });

    order.paymentStatus =
      refundPaise >= Math.round((Number(order.totalAmount) || 0) * 100) ? 'refunded' : 'partially_refunded';
    order.returnInfo = mergeReturnInfo(order.returnInfo, {
      refundContext: 'cancellation',
      refundAmount: refundAmountInr,
      refundId: refund.id,
      status: 'refunded',
      approvedAt: new Date()
    });
    await order.save();
    return { refundAttempted: true, refundWarning: null };
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
    await order.save();
    logger.error('[adminOrderApproval] refund failed after admin cancel', {
      orderId: order.orderId,
      message: refundError?.message
    });
    return {
      refundAttempted: true,
      refundWarning: 'Order cancelled, but refund failed. Support team action required.'
    };
  }
}

/**
 * Confirm a pending order for fulfilment: status → confirmed, then create Shiprocket forward order (no second stock deduct).
 * @param {string} orderId
 * @returns {Promise<object>}
 */
async function runAdminApproveOrderSingle(orderId, opts = {}) {
  const id = String(orderId || '').trim();
  if (!id) {
    return { orderId: orderId || '', success: false, skipped: false, code: 'ORDER_ID_REQUIRED', message: 'orderId is required' };
  }

  try {
    const filter = mergeOrderScopeFilter({ orderId: id }, opts.scopeMatch || null);
    const order = await Order.findOne(filter).populate(FULFILLMENT_ITEM_POPULATE);
    if (!order) {
      return { orderId: id, success: false, skipped: false, code: 'ORDER_NOT_FOUND', message: 'Order not found' };
    }

    const status = String(order.orderStatus || '').toLowerCase();
    if (status === 'confirmed') {
      return {
        orderId: id,
        success: true,
        skipped: true,
        code: 'ALREADY_CONFIRMED',
        message: 'Order is already confirmed.',
        orderStatus: order.orderStatus
      };
    }
    if (status !== 'pending') {
      return {
        orderId: id,
        success: false,
        skipped: false,
        code: 'ORDER_STATUS_NOT_ELIGIBLE',
        message: `Only pending orders can be confirmed (current: ${order.orderStatus || 'unknown'}).`
      };
    }

    const gate = evaluateOrderPaymentForShiprocketFulfillment(order);
    if (!gate.ok) {
      return {
        orderId: id,
        success: false,
        skipped: false,
        code: gate.code || 'PAYMENT_REQUIRED',
        message: gate.message || 'Payment requirements not met for confirmation.'
      };
    }

    order.orderStatus = 'confirmed';
    order.paymentInfo = order.paymentInfo || {};
    order.paymentInfo.adminConfirmedAt = new Date();
    order.markModified('paymentInfo');
    await order.save();

    const shipmentResult = await ensureShipmentForOrderExport({
      order,
      trigger: 'admin_order_confirmed'
    });

    const fresh = await Order.findOne({ orderId: id }).populate(FULFILLMENT_ITEM_POPULATE);

    if (!shipmentResult.success) {
      return {
        orderId: id,
        success: true,
        skipped: false,
        code: 'CONFIRMED_SHIPMENT_DEFERRED',
        message:
          'Order confirmed. Shiprocket create did not complete — retry Ship now or ensure shipment from order detail.',
        orderStatus: fresh?.orderStatus || 'confirmed',
        shipment: {
          success: false,
          code: shipmentResult.code || null,
          message: shipmentResult.message || null
        }
      };
    }

    return {
      orderId: id,
      success: true,
      skipped: false,
      code: null,
      message: shipmentResult.alreadyExists
        ? 'Order confirmed. Shiprocket order already exists.'
        : 'Order confirmed and Shiprocket order created.',
      orderStatus: fresh?.orderStatus || 'confirmed',
      shipment: { success: true, alreadyExists: Boolean(shipmentResult.alreadyExists) }
    };
  } catch (err) {
    logger.error('runAdminApproveOrderSingle', { orderId: id, message: err?.message, stack: err?.stack });
    return {
      orderId: id,
      success: false,
      skipped: false,
      code: 'CONFIRM_INTERNAL_ERROR',
      message: err?.message || 'Confirm failed'
    };
  }
}

/**
 * Cancel a pending order: status → cancelled, restore reserved inventory, refund when applicable.
 * @param {string} orderId
 * @returns {Promise<object>}
 */
async function runAdminCancelOrderSingle(orderId, opts = {}) {
  const id = String(orderId || '').trim();
  if (!id) {
    return { orderId: orderId || '', success: false, skipped: false, code: 'ORDER_ID_REQUIRED', message: 'orderId is required' };
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const filter = mergeOrderScopeFilter({ orderId: id }, opts.scopeMatch || null);
    const order = await Order.findOne(filter).session(session).populate(FULFILLMENT_ITEM_POPULATE);
    if (!order) {
      await session.abortTransaction();
      session.endSession();
      return { orderId: id, success: false, skipped: false, code: 'ORDER_NOT_FOUND', message: 'Order not found' };
    }

    const status = String(order.orderStatus || '').toLowerCase();
    if (status === 'cancelled') {
      await session.abortTransaction();
      session.endSession();
      return {
        orderId: id,
        success: true,
        skipped: true,
        code: 'ALREADY_CANCELLED',
        message: 'Order is already cancelled.'
      };
    }
    if (status !== 'pending') {
      await session.abortTransaction();
      session.endSession();
      return {
        orderId: id,
        success: false,
        skipped: false,
        code: 'ORDER_STATUS_NOT_ELIGIBLE',
        message: `Only pending orders can be cancelled from this action (current: ${order.orderStatus || 'unknown'}).`
      };
    }

    const hasShiprocketAwb = Boolean(order.shipmentInfo?.awbCode || order.shipmentInfo?.trackingNumber);
    const hasScheduledPickup = Boolean(order.shipmentInfo?.pickupScheduledAt || order.shipmentInfo?.pickupDate);
    if (hasShiprocketAwb || hasScheduledPickup) {
      await session.abortTransaction();
      session.endSession();
      return {
        orderId: id,
        success: false,
        skipped: false,
        code: 'ORDER_CANCELLATION_NOT_ALLOWED',
        message: 'Cannot cancel after AWB is assigned or pickup is scheduled.'
      };
    }

    const paymentStatus = String(order.paymentStatus || '').toLowerCase();
    const wasFullyPaid = paymentStatus === 'paid';
    const wasPartiallyPaid = paymentStatus === 'partially_paid';
    const hadCapturedPayment = wasFullyPaid || wasPartiallyPaid;
    const canInitiateRefund =
      hadCapturedPayment &&
      Boolean(order.paymentInfo?.razorpayPaymentId);
    const refundAmountInr = canInitiateRefund ? getCancelledOrderRefundAmount(order) : 0;

    order.orderStatus = 'cancelled';
    if (!hadCapturedPayment && String(order.paymentInfo?.method || '').toLowerCase() === 'online') {
      order.paymentStatus = 'failed';
    }
    normalizeTerminalUnpaidFinancials(order);
    order.paymentInfo = order.paymentInfo || {};
    order.paymentInfo.cancellationReason = 'admin_cancelled';
    order.paymentInfo.cancelledAt = new Date();
    order.returnInfo = mergeReturnInfo(order.returnInfo, {
      refundContext: 'cancellation',
      status: canInitiateRefund ? 'refund_pending' : hadCapturedPayment ? 'refund_unavailable' : 'not_required',
      requestedAt: new Date(),
      refundAmount: canInitiateRefund ? refundAmountInr : order.returnInfo?.refundAmount || 0
    });
    order.markModified('paymentInfo');
    order.markModified('returnInfo');

    await order.save({ session });
    await releaseReservedInventoryForOrder(order, session);

    await session.commitTransaction();
    session.endSession();

    let refundWarning = null;
    if (canInitiateRefund) {
      const refundOutcome = await attemptRefundForCancelledPaidOrder(order, { reason: 'Order cancelled by admin' });
      refundWarning = refundOutcome.refundWarning;
    }

    return {
      orderId: id,
      success: true,
      skipped: false,
      code: null,
      message: refundWarning || 'Order cancelled and inventory restored.',
      refundWarning: refundWarning || undefined
    };
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    logger.error('runAdminCancelOrderSingle', { orderId: id, message: err?.message, stack: err?.stack });
    return {
      orderId: id,
      success: false,
      skipped: false,
      code: 'CANCEL_INTERNAL_ERROR',
      message: err?.message || 'Cancel failed'
    };
  }
}

module.exports = {
  runAdminApproveOrderSingle,
  runAdminCancelOrderSingle
};
