/**
 * Full paid-amount RTO refund (courier no-attempt) — unit tests.
 * Run: node scripts/test-rto-full-amount-refund.js
 */
process.env.RTO_MIN_ORDER_VALUE_FOR_REFUND = '100';
process.env.RTO_MIN_REFUND_THRESHOLD = '20';
process.env.RTO_PLATFORM_FEE_TIERS = JSON.stringify([
  { min: 100, max: 200, percent: 8, cap: 16 },
  { min: 201, max: 500, percent: 6, cap: 30 },
  { min: 501, max: 1000, percent: 5, cap: 50 },
  { min: 1001, max: null, percent: 4.5, cap: 200 }
]);

const { resetPlatformFeeTiersCache } = require('../config/rtoPlatformFee.config');
resetPlatformFeeTiersCache();

const {
  orderHasDeliveryAttemptOrCustomerFault,
  isCourierNoAttemptRto,
  calculateFullPaidAmountRtoRefund,
  calculateRtoRefund,
  canOfferFullPaidAmountRtoRefund
} = require('../services/rtoRefund.service');

let passed = 0;
let failed = 0;

function assert(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function baseOrder(overrides = {}) {
  return {
    paymentInfo: { method: 'online', razorpayPaymentId: 'pay_test_1' },
    paymentStatus: 'paid',
    subtotal: 800,
    deliveryCharges: 110,
    totalAmount: 910,
    amountPaidInr: 910,
    refundHistory: [],
    returnInfo: {
      rtoStatus: 'pending',
      rtoWarehouseDeliveredAt: new Date('2026-01-01T00:00:00Z')
    },
    shipmentInfo: {
      providerStatus: 'RTO Delivered',
      rawEvents: [
        { status: 'RTO Initiated', at: '2026-01-01T10:00:00Z' },
        { status: 'RTO In Transit', at: '2026-01-02T10:00:00Z' },
        { status: 'RTO Delivered', at: '2026-01-03T10:00:00Z' }
      ]
    },
    ...overrides
  };
}

console.log('\n1) Detector — no attempt');
{
  const o = baseOrder();
  assert('no attempt on silent RTO', isCourierNoAttemptRto(o) === true);
  assert('hasAttempt false', orderHasDeliveryAttemptOrCustomerFault(o) === false);
}

console.log('\n2) Detector — Out For Delivery');
{
  const o = baseOrder({
    shipmentInfo: {
      providerStatus: 'RTO Delivered',
      rawEvents: [
        { status: 'Out For Delivery', at: '2026-01-01T10:00:00Z' },
        { status: 'RTO Initiated', at: '2026-01-02T10:00:00Z' },
        { status: 'RTO Delivered', at: '2026-01-03T10:00:00Z' }
      ]
    }
  });
  assert('OFD blocks full amount', orderHasDeliveryAttemptOrCustomerFault(o) === true);
  assert('calc blocked', calculateFullPaidAmountRtoRefund(o).eligible === false);
  assert(
    'blocked reason attempt',
    calculateFullPaidAmountRtoRefund(o).reason === 'delivery_attempt_or_customer_fault'
  );
}

console.log('\n3) Detector — Not Contactable (Shipmozo-style status)');
{
  const o = baseOrder({
    shipmentInfo: {
      providerStatus: 'RTO Delivered',
      rawEvents: [
        { status: 'Not Contactable', time: '10:00', date: '01-01-2026' },
        { status: 'RTO Delivered', time: '12:00', date: '03-01-2026' }
      ]
    }
  });
  assert('not contactable = fault', orderHasDeliveryAttemptOrCustomerFault(o) === true);
  assert('full amount not eligible', calculateFullPaidAmountRtoRefund(o).eligible === false);
}

console.log('\n4) Detector — customer refuse');
{
  const o = baseOrder({
    shipmentInfo: {
      providerStatus: 'RTO Delivered',
      rawEvents: [{ status: 'Customer refused to accept', at: '2026-01-01T10:00:00Z' }]
    }
  });
  assert('refuse = fault', orderHasDeliveryAttemptOrCustomerFault(o) === true);
}

console.log('\n5) Full amount calc — full paid silent RTO');
{
  const o = baseOrder();
  const calc = calculateFullPaidAmountRtoRefund(o);
  assert('eligible', calc.eligible === true);
  assert('max = paid', calc.maxRefundableInr === 910, `got ${calc.maxRefundableInr}`);
  assert('deductions zero', calc.totalDeductions === 0);
  assert('mode', calc.refundMode === 'full_paid_amount');
  assert('can offer', canOfferFullPaidAmountRtoRefund(o) === true);

  const standard = calculateRtoRefund(o);
  assert('standard still eligible independently', standard.eligible === true);
  assert('standard net < paid', standard.maxRefundableInr < 910);
}

console.log('\n6) Full amount calc — partial paid silent RTO');
{
  const o = baseOrder({
    paymentStatus: 'partially_paid',
    totalAmount: 1200,
    amountPaidInr: 400,
    subtotal: 1100,
    deliveryCharges: 100
  });
  const calc = calculateFullPaidAmountRtoRefund(o);
  assert('partial eligible for full-amount path', calc.eligible === true);
  assert('refunds only paid', calc.maxRefundableInr === 400, `got ${calc.maxRefundableInr}`);
  assert('standard still blocked for partial', calculateRtoRefund(o).eligible === false);
  assert('can offer partial', canOfferFullPaidAmountRtoRefund(o) === true);
}

console.log('\n7) COD blocked');
{
  const o = baseOrder({
    paymentInfo: { method: 'cod' },
    paymentStatus: 'pending',
    amountPaidInr: 0
  });
  assert('cod not eligible', calculateFullPaidAmountRtoRefund(o).eligible === false);
  assert('cannot offer cod', canOfferFullPaidAmountRtoRefund(o) === false);
}

console.log('\n8) Already refunded amount reduces remaining');
{
  const o = baseOrder({
    refundHistory: [{ amountInr: 100, reason: 'other' }]
  });
  const calc = calculateFullPaidAmountRtoRefund(o);
  assert('remaining 810', calc.maxRefundableInr === 810, `got ${calc.maxRefundableInr}`);
}

console.log('\n9) Stored customer category blocks');
{
  const o = baseOrder({
    returnInfo: {
      rtoStatus: 'pending',
      rtoWarehouseDeliveredAt: new Date('2026-01-01T00:00:00Z'),
      rtoReasonCategory: 'customer'
    }
  });
  assert('category customer blocks', orderHasDeliveryAttemptOrCustomerFault(o) === true);
  assert('not offerable', canOfferFullPaidAmountRtoRefund(o) === false);
}

console.log('\n10) Warehouse not delivered → cannot offer');
{
  const o = baseOrder({
    returnInfo: { rtoStatus: 'pending', rtoWarehouseDeliveredAt: null },
    shipmentInfo: {
      providerStatus: 'RTO Initiated',
      rawEvents: [{ status: 'RTO Initiated', at: '2026-01-01T10:00:00Z' }]
    }
  });
  assert('no warehouse latch', canOfferFullPaidAmountRtoRefund(o) === false);
}

console.log(`\nDone: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
