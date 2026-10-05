'use strict';

/**
 * Dropship payment verify — thin ownership gate then delegates to core order verify.
 * Keeps capture / inventory commit / hold-clear logic identical to ecomm.
 */

const Order = require('../../models/Order');
const { DROPSHIP_STOREFRONT } = require('./dropshipOrder.service');

function normalizeOrderUserId(order) {
  if (!order || order.userId == null) return null;
  const u = order.userId;
  if (typeof u === 'object' && u._id != null) return String(u._id);
  return String(u);
}

/**
 * Ensure order is dropship and caller owns it (or placed it).
 * @returns {Promise<{ ok: true, order } | { ok: false, statusCode, code, message }>}
 */
async function assertDropshipPaymentAccess(orderId, userId) {
  const order = await Order.findOne({ orderId: String(orderId || '').trim() }).lean();
  if (!order) {
    return { ok: false, statusCode: 404, code: 'ORDER_NOT_FOUND', message: 'Order not found' };
  }
  if (String(order.storefront || '') !== DROPSHIP_STOREFRONT) {
    return {
      ok: false,
      statusCode: 400,
      code: 'NOT_DROPSHIP_ORDER',
      message: 'This endpoint only verifies dropship orders'
    };
  }

  const requester = userId != null ? String(userId) : null;
  const owner = normalizeOrderUserId(order);
  const placedBy =
    order.dropshipMeta?.placedByUserId != null
      ? String(order.dropshipMeta.placedByUserId)
      : null;

  if (!requester || (requester !== owner && requester !== placedBy)) {
    return { ok: false, statusCode: 403, code: 'ORDER_ACCESS_DENIED', message: 'Unauthorized' };
  }

  return { ok: true, order };
}

module.exports = {
  assertDropshipPaymentAccess
};
