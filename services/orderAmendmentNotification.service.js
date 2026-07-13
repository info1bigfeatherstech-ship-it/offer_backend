/**
 * In-app notifications for admin pending-order amendments (English).
 * Upserts type `order_amended` so repeat edits refresh the same notification row
 * without conflicting with RTO refund notification types.
 */
const UserNotification = require('../models/UserNotification');
const logger = require('../utils/logger');
const { roundMoney2 } = require('./checkoutComputation.service');

function formatInrDisplay(amount) {
  const n = roundMoney2(Number(amount) || 0);
  return n % 1 === 0 ? String(Math.round(n)) : n.toFixed(2);
}

/**
 * @param {import('mongoose').Document|object} order
 * @param {string} [message]
 * @param {{ refundInr?: number, balanceDueInr?: number, newTotal?: number, cancelledEmpty?: boolean }} [meta]
 */
async function notifyOrderAmended(order, message, meta = {}) {
  const userId = order?.userId?._id || order?.userId;
  const orderId = String(order?.orderId || '').trim();
  if (!userId || !orderId) {
    return { created: false, notification: null };
  }

  const refundInr = roundMoney2(Number(meta.refundInr) || 0);
  const body =
    String(message || '').trim() ||
    (meta.cancelledEmpty
      ? `Your order #${orderId} was updated and cancelled because items were unavailable.`
      : `Your order #${orderId} was updated because one or more items were unavailable.`);

  const title = meta.cancelledEmpty
    ? 'Order Cancelled — Items Unavailable'
    : refundInr > 0.005
      ? 'Order Updated — Refund Processed'
      : 'Order Updated';

  const payload = {
    userId,
    orderId,
    type: 'order_amended',
    title,
    body,
    read: false,
    sentAt: new Date(),
    metadata: {
      reason: meta.cancelledEmpty ? 'order_cancelled_empty' : 'order_amended',
      refundAmount: refundInr > 0 ? refundInr : null,
      orderTotal: meta.newTotal != null ? roundMoney2(meta.newTotal) : roundMoney2(Number(order.totalAmount) || 0),
      policyUrl: null
    }
  };

  try {
    const notification = await UserNotification.findOneAndUpdate(
      { userId, orderId, type: 'order_amended' },
      { $set: payload },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    return { created: true, notification };
  } catch (err) {
    logger.warn('[orderAmendmentNotification] notify failed', {
      orderId,
      message: err.message
    });
    return { created: false, notification: null };
  }
}

module.exports = {
  notifyOrderAmended,
  formatInrDisplay
};
