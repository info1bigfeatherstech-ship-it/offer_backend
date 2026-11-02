'use strict';

/**
 * Same-day ship payment rules (isolated from courier / COD / advance).
 * SDD checkout is full online capture only. After an admin item-remove refund,
 * paymentStatus becomes partially_refunded while the remaining bill stays paid.
 */

const { roundMoney2 } = require('../../services/checkoutComputation.service');
const { createSddHttpError } = require('./sameDayDeliveryMode');

function evaluateSameDayShipPayment(order) {
  const status = String(order?.paymentStatus || '').toLowerCase();
  const total = roundMoney2(Number(order?.totalAmount) || 0);
  const paid = roundMoney2(Number(order?.amountPaidInr) || 0);
  const itemCount = Array.isArray(order?.items) ? order.items.length : 0;

  if (status === 'refunded' || status === 'failed') {
    return {
      ok: false,
      code: 'ORDER_NOT_PAID',
      message: 'Order must be paid before shipping.',
    };
  }

  if (status === 'partially_paid' || status === 'pending' || status === 'initiated') {
    return {
      ok: false,
      code: 'ORDER_NOT_PAID',
      message: 'Same day orders must be fully paid before shipping.',
    };
  }

  if (!(total > 0.01) || itemCount === 0) {
    return {
      ok: false,
      code: 'ORDER_EMPTY',
      message: 'Nothing left to ship on this order.',
    };
  }

  if (paid + 0.01 < total) {
    return {
      ok: false,
      code: 'ORDER_NOT_PAID',
      message: 'Order must be paid before shipping.',
    };
  }

  if (status === 'paid' || status === 'partially_refunded') {
    return {
      ok: true,
      reason: status === 'paid' ? 'paid_in_full' : 'partially_refunded_remaining_paid',
    };
  }

  return {
    ok: false,
    code: 'ORDER_NOT_PAID',
    message: 'Order must be paid before shipping.',
  };
}

function assertSameDayShipPayment(order) {
  const result = evaluateSameDayShipPayment(order);
  if (!result.ok) {
    throw createSddHttpError(400, result.code, result.message);
  }
  return result;
}

module.exports = {
  evaluateSameDayShipPayment,
  assertSameDayShipPayment,
};
