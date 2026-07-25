/**
 * Pure checks for OOS shipping settlement deferral (no DB / Razorpay).
 * Run: node scripts/verify-oos-shipping-settlement.js
 */
const assert = require('assert');
const {
  shouldDeferShippingSettlement,
  buildOosShippingSettlementMeta
} = require('../services/oosShippingSettlement.service');
const { settleFinancials, roundMoney2 } = (() => {
  const edit = require('../services/adminPendingOrderEdit.service');
  const { roundMoney2 } = require('../services/checkoutComputation.service');
  return { settleFinancials: edit.settleFinancials, roundMoney2 };
})();

function testDeferOnlineKeepsOldShipping() {
  const order = {
    paymentStatus: 'paid',
    amountPaidInr: 1453.56,
    paymentInfo: { method: 'online' },
    refundHistory: []
  };
  const priced = {
    oldDelivery: 400,
    quotedDelivery: 58,
    subtotal: 637,
    tax: 0,
    discount: 0,
    shipMeta: { mock: true }
  };
  assert.strictEqual(shouldDeferShippingSettlement(order, priced), true);

  const heldTotal = roundMoney2(priced.subtotal + priced.oldDelivery + priced.tax - priced.discount);
  const settlement = settleFinancials(order, heldTotal);
  // Item-only excess: 1453.56 - 1037 = 416.56
  assert.ok(Math.abs(settlement.refundInr - 416.56) < 0.011, `refund ${settlement.refundInr}`);

  const immediateMockTotal = roundMoney2(priced.subtotal + priced.quotedDelivery);
  const bad = settleFinancials(order, immediateMockTotal);
  assert.ok(bad.refundInr > settlement.refundInr, 'mock shipping must not drive larger immediate refund');

  const meta = buildOosShippingSettlementMeta(order, priced);
  assert.strictEqual(meta.pending, true);
  assert.strictEqual(meta.heldDeliveryCharges, 400);
  console.log('ok defer online keeps old shipping / item-only refund');
}

function testCodDoesNotDefer() {
  const order = {
    paymentStatus: 'pending',
    amountPaidInr: 0,
    paymentInfo: { method: 'cod' }
  };
  assert.strictEqual(
    shouldDeferShippingSettlement(order, { oldDelivery: 200, quotedDelivery: 50 }),
    false
  );
  console.log('ok COD does not defer');
}

function testZeroShippingNoDefer() {
  const order = {
    paymentStatus: 'paid',
    amountPaidInr: 500,
    paymentInfo: { method: 'online' }
  };
  assert.strictEqual(
    shouldDeferShippingSettlement(order, { oldDelivery: 0, quotedDelivery: 0 }),
    false
  );
  console.log('ok zero shipping no defer');
}

function testPostShipSettlementMath() {
  const held = 400;
  const actual = 112;
  const customerDelivery = Math.min(held, actual);
  const subtotal = 637;
  const newTotal = roundMoney2(subtotal + customerDelivery);
  const amountPaidAfterItemRefund = 1037;
  const refundInr = roundMoney2(Math.max(0, amountPaidAfterItemRefund - newTotal));
  assert.strictEqual(customerDelivery, 112);
  assert.strictEqual(newTotal, 749);
  assert.strictEqual(refundInr, 288);
  console.log('ok post-ship settlement math');
}

testDeferOnlineKeepsOldShipping();
testCodDoesNotDefer();
testZeroShippingNoDefer();
testPostShipSettlementMath();
console.log('all verify-oos-shipping-settlement checks passed');
