/**
 * Lightweight sanity checks for Shiprocket fulfilment payment gate (no Jest required).
 * Run: node scripts/verify-order-fulfillment-payment-gate.js
 */
const assert = require('assert');
const {
  evaluateOrderPaymentForShiprocketFulfillment,
  isPartiallyRefundedStillShippable
} = require('../utils/orderFulfillmentPaymentGate');

function run() {
  const paidOnline = {
    totalAmount: 2114.16,
    amountPaidInr: 2114.16,
    paymentStatus: 'paid',
    paymentInfo: { method: 'online' }
  };
  assert.strictEqual(evaluateOrderPaymentForShiprocketFulfillment(paidOnline).ok, true);
  assert.strictEqual(evaluateOrderPaymentForShiprocketFulfillment(paidOnline).reason, 'paid_in_full');

  const codPending = {
    totalAmount: 500,
    amountPaidInr: 0,
    paymentStatus: 'pending',
    paymentInfo: { method: 'cod' }
  };
  assert.strictEqual(evaluateOrderPaymentForShiprocketFulfillment(codPending).ok, true);

  const unpaidOnline = {
    totalAmount: 500,
    amountPaidInr: 0,
    paymentStatus: 'pending',
    paymentInfo: { method: 'online' }
  };
  assert.strictEqual(evaluateOrderPaymentForShiprocketFulfillment(unpaidOnline).ok, false);
  assert.strictEqual(evaluateOrderPaymentForShiprocketFulfillment(unpaidOnline).code, 'PAYMENT_REQUIRED');

  const failed = {
    totalAmount: 500,
    amountPaidInr: 0,
    paymentStatus: 'failed',
    paymentInfo: { method: 'online' }
  };
  assert.strictEqual(evaluateOrderPaymentForShiprocketFulfillment(failed).ok, false);
  assert.strictEqual(evaluateOrderPaymentForShiprocketFulfillment(failed).code, 'PAYMENT_NOT_SUCCESSFUL');

  const fullyRefunded = {
    totalAmount: 500,
    amountPaidInr: 0,
    paymentStatus: 'refunded',
    paymentInfo: { method: 'online' }
  };
  assert.strictEqual(evaluateOrderPaymentForShiprocketFulfillment(fullyRefunded).ok, false);
  assert.strictEqual(evaluateOrderPaymentForShiprocketFulfillment(fullyRefunded).code, 'PAYMENT_NOT_SUCCESSFUL');

  // Amendment / Razorpay webhook: partial refund must NOT block label/shipping when balance remains.
  const partialRefundShippable = {
    totalAmount: 2114.16,
    amountPaidInr: 2114.16,
    paymentStatus: 'partially_refunded',
    paymentInfo: { method: 'online' },
    refundHistory: [{ refundId: 'rfnd_TDKWCS3phdQXLM', amountInr: 109.8, status: 'pending' }]
  };
  assert.strictEqual(isPartiallyRefundedStillShippable(partialRefundShippable), true);
  const gatePartial = evaluateOrderPaymentForShiprocketFulfillment(partialRefundShippable);
  assert.strictEqual(gatePartial.ok, true);
  assert.strictEqual(gatePartial.reason, 'partially_refunded_balance_shippable');

  const prepaidPartial = {
    ...partialRefundShippable,
    paymentInfo: { method: 'prepaid' }
  };
  assert.strictEqual(evaluateOrderPaymentForShiprocketFulfillment(prepaidPartial).ok, true);

  // Empty / zero remaining bill after remove-all — still block.
  const partialButEmpty = {
    totalAmount: 0,
    amountPaidInr: 0,
    paymentStatus: 'partially_refunded',
    paymentInfo: { method: 'online' }
  };
  assert.strictEqual(isPartiallyRefundedStillShippable(partialButEmpty), false);
  assert.strictEqual(evaluateOrderPaymentForShiprocketFulfillment(partialButEmpty).ok, false);

  const advanceCod = {
    totalAmount: 1000,
    amountPaidInr: 200,
    paymentStatus: 'partially_paid',
    paymentInfo: {
      method: 'online',
      splitMode: 'advance',
      balanceCollectionMethod: 'cod',
      advancePercent: 20
    }
  };
  assert.strictEqual(evaluateOrderPaymentForShiprocketFulfillment(advanceCod).ok, true);

  console.log('verify-order-fulfillment-payment-gate: OK');
}

run();
