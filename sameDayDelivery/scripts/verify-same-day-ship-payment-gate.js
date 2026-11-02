/**
 * Same-day ship payment gate sanity checks (no Jest).
 * Run: node sameDayDelivery/scripts/verify-same-day-ship-payment-gate.js
 */
'use strict';

const assert = require('assert');
const { evaluateSameDayShipPayment } = require('../utils/sameDayShipPaymentGate');
const { buildSameDayPendingMatch } = require('../constants/sameDayDeliveryOrderQuery');

function run() {
  const paid = evaluateSameDayShipPayment({
    items: [{ quantity: 1 }],
    totalAmount: 99,
    amountPaidInr: 99,
    paymentStatus: 'paid',
  });
  assert.strictEqual(paid.ok, true);
  assert.strictEqual(paid.reason, 'paid_in_full');

  const afterItemRemove = evaluateSameDayShipPayment({
    items: [{ quantity: 1 }],
    totalAmount: 99,
    amountPaidInr: 99,
    paymentStatus: 'partially_refunded',
  });
  assert.strictEqual(afterItemRemove.ok, true);
  assert.strictEqual(afterItemRemove.reason, 'partially_refunded_remaining_paid');

  const partialPay = evaluateSameDayShipPayment({
    items: [{ quantity: 1 }],
    totalAmount: 99,
    amountPaidInr: 40,
    paymentStatus: 'partially_paid',
  });
  assert.strictEqual(partialPay.ok, false);
  assert.strictEqual(partialPay.code, 'ORDER_NOT_PAID');

  const fullRefund = evaluateSameDayShipPayment({
    items: [{ quantity: 1 }],
    totalAmount: 99,
    amountPaidInr: 0,
    paymentStatus: 'refunded',
  });
  assert.strictEqual(fullRefund.ok, false);

  const unpaidGap = evaluateSameDayShipPayment({
    items: [{ quantity: 1 }],
    totalAmount: 99,
    amountPaidInr: 50,
    paymentStatus: 'partially_refunded',
  });
  assert.strictEqual(unpaidGap.ok, false);

  const empty = evaluateSameDayShipPayment({
    items: [],
    totalAmount: 0,
    amountPaidInr: 0,
    paymentStatus: 'paid',
  });
  assert.strictEqual(empty.ok, false);
  assert.strictEqual(empty.code, 'ORDER_EMPTY');

  const pendingMatch = buildSameDayPendingMatch();
  assert.deepStrictEqual(pendingMatch.paymentStatus.$in, ['paid', 'partially_refunded']);
  assert.ok(!pendingMatch.paymentStatus.$in.includes('partially_paid'));

  console.log('same-day ship payment gate ok');
}

run();
