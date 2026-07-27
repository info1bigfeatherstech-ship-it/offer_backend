/**
 * Policy v3 OOS settlement — production guards.
 * Run: node scripts/verify-oos-shipping-settlement.js
 */
const assert = require('assert');
const {
  shouldDeferShippingSettlement,
  computeDeferredApplyFinancials,
  computeFinalOosSettlement,
  pickPositiveFreightInr,
  resolveSettlementFreightInr,
  buildOosShippingSettlementMeta
} = require('../services/oosShippingSettlement.service');
const { roundMoney2 } = require('../services/checkoutComputation.service');

function approx(a, b, eps = 0.011) {
  assert.ok(Math.abs(roundMoney2(a) - roundMoney2(b)) < eps, `expected ${b} got ${a}`);
}

function testRejectZeroFreight() {
  assert.strictEqual(pickPositiveFreightInr(0), null);
  assert.strictEqual(pickPositiveFreightInr(-1), null);
  assert.strictEqual(pickPositiveFreightInr(null, 0, 52.36), 52.36);

  const math0 = computeFinalOosSettlement({
    subtotal: 49,
    tax: 0,
    discount: 0,
    actualFreightInr: 0,
    amountPaidInr: 150.36,
    maxBalanceDueInr: 0
  });
  assert.strictEqual(math0.ok, false);
  assert.strictEqual(math0.reason, 'freight_not_positive');

  const pick = resolveSettlementFreightInr({
    actualFreightInr: 0,
    heldDeliveryCharges: 52.36,
    assignRaw: null
  });
  assert.strictEqual(pick.source, 'held_fallback');
  approx(pick.freightInr, 52.36);

  const pickNone = resolveSettlementFreightInr({
    actualFreightInr: 0,
    heldDeliveryCharges: 0,
    assignRaw: null
  });
  assert.strictEqual(pickNone.freightInr, null);
  console.log('ok reject zero freight / held fallback');
}

function testCorrectRefundThisOrder() {
  // Paid 150.36, items 49, ship 52.36 → refund 49 (NOT 101.36)
  const s = computeFinalOosSettlement({
    subtotal: 49,
    tax: 0,
    discount: 0,
    actualFreightInr: 52.36,
    amountPaidInr: 150.36,
    maxBalanceDueInr: 0
  });
  assert.strictEqual(s.ok, true);
  approx(s.newTotal, 101.36);
  approx(s.refundInr, 49);
  assert.strictEqual(s.balanceDueInr, 0);
  console.log('ok correct refund is 49 not 101.36');
}

function testActualPreferredOverHeld() {
  const pick = resolveSettlementFreightInr({
    actualFreightInr: 70,
    heldDeliveryCharges: 52.36
  });
  assert.strictEqual(pick.source, 'actual');
  approx(pick.freightInr, 70);

  const s = computeFinalOosSettlement({
    subtotal: 49,
    tax: 0,
    discount: 0,
    actualFreightInr: 70,
    amountPaidInr: 150.36,
    maxBalanceDueInr: 0
  });
  approx(s.newTotal, 119);
  approx(s.refundInr, 31.36);
  console.log('ok actual freight preferred');
}

function testDeferAndApply() {
  assert.strictEqual(
    shouldDeferShippingSettlement({
      paymentStatus: 'paid',
      amountPaidInr: 150,
      paymentInfo: { method: 'online' }
    }),
    true
  );
  const apply = computeDeferredApplyFinancials(
    { amountPaidInr: 150.36, balanceDueInr: 0, paymentStatus: 'paid' },
    101.36
  );
  assert.strictEqual(apply.refundInr, 0);
  assert.strictEqual(apply.amountPaidInr, 150.36);
  console.log('ok apply defers refund');
}

function testPartialDueCap() {
  const s = computeFinalOosSettlement({
    subtotal: 400,
    tax: 0,
    discount: 0,
    actualFreightInr: 70,
    amountPaidInr: 200,
    maxBalanceDueInr: 258
  });
  approx(s.idealDue, 270);
  approx(s.balanceDueInr, 258);
  approx(s.absorbedShortfallInr, 12);
  console.log('ok partial due cap');
}

function testMetaV3() {
  const meta = buildOosShippingSettlementMeta(
    { amountPaidInr: 150.36, balanceDueInr: 0 },
    {
      oldDelivery: 52.36,
      quotedDelivery: 52.36,
      subtotal: 49,
      tax: 0,
      discount: 0,
      shipMeta: { mock: false },
      shippingSnapshot: {}
    }
  );
  assert.strictEqual(meta.policyVersion, 3);
  assert.strictEqual(meta.pending, true);
  console.log('ok meta v3');
}

function testFreeShippingZeroAllowed() {
  const pick = resolveSettlementFreightInr({
    actualFreightInr: null,
    heldDeliveryCharges: 0,
    allowZeroHeld: true
  });
  assert.strictEqual(pick.source, 'held_zero_free_shipping');
  assert.strictEqual(pick.freightInr, 0);

  const s = computeFinalOosSettlement({
    subtotal: 49,
    tax: 0,
    discount: 0,
    actualFreightInr: 0,
    amountPaidInr: 150.36,
    maxBalanceDueInr: 0,
    allowZeroFreight: true
  });
  assert.strictEqual(s.ok, true);
  approx(s.newTotal, 49);
  approx(s.refundInr, 101.36);
  console.log('ok free-shipping zero freight when held was 0');
}

function testNeverZeroWhenHeldPositive() {
  // Regression: missing actual must NOT become freight 0 when held > 0
  const pick = resolveSettlementFreightInr({
    actualFreightInr: null,
    heldDeliveryCharges: 52.36,
    allowZeroHeld: true
  });
  assert.strictEqual(pick.source, 'held_fallback');
  approx(pick.freightInr, 52.36);
  const s = computeFinalOosSettlement({
    subtotal: 49,
    tax: 0,
    discount: 0,
    actualFreightInr: pick.freightInr,
    amountPaidInr: 150.36,
    maxBalanceDueInr: 0
  });
  approx(s.refundInr, 49);
  assert.ok(Math.abs(s.refundInr - 101.36) > 1, 'must not over-refund shipping');
  console.log('ok never invent zero freight when held > 0');
}

testRejectZeroFreight();
testCorrectRefundThisOrder();
testActualPreferredOverHeld();
testDeferAndApply();
testPartialDueCap();
testMetaV3();
testFreeShippingZeroAllowed();
testNeverZeroWhenHeldPositive();
console.log('all verify-oos-shipping-settlement policy v3 checks passed');
