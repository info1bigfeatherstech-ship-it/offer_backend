/**
 * Full paid-amount RTO refund + admin matrix — unit tests.
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
  canOfferFullPaidAmountRtoRefund,
  canOfferStandardRtoRefund,
  resolveOrderRtoReasonCategory
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
  const { returnInfo: riOverride, shipmentInfo: siOverride, ...rest } = overrides;
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
      rtoWarehouseDeliveredAt: new Date('2026-01-01T00:00:00Z'),
      ...(riOverride || {})
    },
    shipmentInfo: {
      providerStatus: 'RTO Delivered',
      rawEvents: [
        { status: 'RTO Initiated', at: '2026-01-01T10:00:00Z' },
        { status: 'RTO In Transit', at: '2026-01-02T10:00:00Z' },
        { status: 'RTO Delivered', at: '2026-01-03T10:00:00Z' }
      ],
      ...(siOverride || {})
    },
    ...rest
  };
}

console.log('\n1) Detector — no attempt (analytics only)');
{
  const o = baseOrder();
  assert('no attempt on silent RTO', isCourierNoAttemptRto(o) === true);
  assert('hasAttempt false', orderHasDeliveryAttemptOrCustomerFault(o) === false);
}

console.log('\n2) Detector — Out For Delivery still detected, but full refund NOT blocked');
{
  const o = baseOrder({
    shipmentInfo: {
      providerStatus: 'RTO Delivered',
      rawEvents: [
        { status: 'Out For Delivery', at: '2026-01-01T10:00:00Z' },
        { status: 'RTO Initiated', at: '2026-01-02T10:00:00Z' },
        { status: 'RTO Delivered', at: '2026-01-03T10:00:00Z' }
      ]
    },
    returnInfo: {
      rtoStatus: 'pending',
      rtoWarehouseDeliveredAt: new Date('2026-01-01T00:00:00Z'),
      rtoReasonCategory: 'courier'
    }
  });
  assert('OFD detected', orderHasDeliveryAttemptOrCustomerFault(o) === true);
  assert('full amount still eligible after OFD', calculateFullPaidAmountRtoRefund(o).eligible === true);
  assert('can offer full after OFD', canOfferFullPaidAmountRtoRefund(o) === true);
  assert('net also offerable', canOfferStandardRtoRefund(o) === true);
}

console.log('\n3) Fully paid + customer fault → both net and full');
{
  const o = baseOrder({
    returnInfo: {
      rtoStatus: 'pending',
      rtoWarehouseDeliveredAt: new Date('2026-01-01T00:00:00Z'),
      rtoReasonCategory: 'customer'
    }
  });
  assert('category customer', resolveOrderRtoReasonCategory(o) === 'customer');
  assert('full offerable', canOfferFullPaidAmountRtoRefund(o) === true);
  assert('net offerable', canOfferStandardRtoRefund(o) === true);
}

console.log('\n4) Fully paid + courier fault → both');
{
  const o = baseOrder({
    returnInfo: {
      rtoStatus: 'pending',
      rtoWarehouseDeliveredAt: new Date('2026-01-01T00:00:00Z'),
      rtoReasonCategory: 'courier',
      rtoShiprocketReason: 'pincode_updated'
    }
  });
  assert('category courier', resolveOrderRtoReasonCategory(o) === 'courier');
  assert('full offerable', canOfferFullPaidAmountRtoRefund(o) === true);
  assert('net offerable', canOfferStandardRtoRefund(o) === true);
  const full = calculateFullPaidAmountRtoRefund(o);
  assert('full = paid', full.maxRefundableInr === 910, `got ${full.maxRefundableInr}`);
  const standard = calculateRtoRefund(o);
  assert('standard net < paid', standard.maxRefundableInr < 910);
}

console.log('\n5) Partial + courier → both (full = amount paid)');
{
  const o = baseOrder({
    paymentStatus: 'partially_paid',
    totalAmount: 1200,
    amountPaidInr: 400,
    subtotal: 1100,
    deliveryCharges: 100,
    returnInfo: {
      rtoStatus: 'pending',
      rtoWarehouseDeliveredAt: new Date('2026-01-01T00:00:00Z'),
      rtoReasonCategory: 'courier'
    }
  });
  const calc = calculateFullPaidAmountRtoRefund(o);
  assert('partial courier full eligible', calc.eligible === true);
  assert('refunds only paid', calc.maxRefundableInr === 400, `got ${calc.maxRefundableInr}`);
  assert('standard eligible for partial', calculateRtoRefund(o).eligible === true);
  assert('can offer full', canOfferFullPaidAmountRtoRefund(o) === true);
  assert('can offer net', canOfferStandardRtoRefund(o) === true);
}

console.log('\n6) Partial + customer → net only (no full)');
{
  const o = baseOrder({
    paymentStatus: 'partially_paid',
    totalAmount: 1200,
    amountPaidInr: 400,
    subtotal: 1100,
    deliveryCharges: 100,
    returnInfo: {
      rtoStatus: 'pending',
      rtoWarehouseDeliveredAt: new Date('2026-01-01T00:00:00Z'),
      rtoReasonCategory: 'customer'
    }
  });
  assert('full blocked', calculateFullPaidAmountRtoRefund(o).eligible === false);
  assert('cannot offer full', canOfferFullPaidAmountRtoRefund(o) === false);
  assert('net still possible when above threshold', canOfferStandardRtoRefund(o) === true);
}

console.log('\n7) COD blocked');
{
  const o = baseOrder({
    paymentInfo: { method: 'cod' },
    paymentStatus: 'pending',
    amountPaidInr: 0
  });
  assert('cod not eligible', calculateFullPaidAmountRtoRefund(o).eligible === false);
  assert('cannot offer full', canOfferFullPaidAmountRtoRefund(o) === false);
  assert('cannot offer net', canOfferStandardRtoRefund(o) === false);
}

console.log('\n8) Already refunded amount reduces remaining');
{
  const o = baseOrder({
    refundHistory: [{ amountInr: 100, reason: 'other' }]
  });
  const calc = calculateFullPaidAmountRtoRefund(o);
  assert('remaining 810', calc.maxRefundableInr === 810, `got ${calc.maxRefundableInr}`);
}

console.log('\n9) Warehouse not delivered → cannot offer either');
{
  const o = baseOrder({
    returnInfo: { rtoStatus: 'pending', rtoWarehouseDeliveredAt: null, rtoReasonCategory: 'courier' },
    shipmentInfo: {
      providerStatus: 'RTO Initiated',
      rawEvents: [{ status: 'RTO Initiated', at: '2026-01-01T10:00:00Z' }]
    }
  });
  assert('no warehouse → no full', canOfferFullPaidAmountRtoRefund(o) === false);
  assert('no warehouse → no net', canOfferStandardRtoRefund(o) === false);
}

console.log('\n10) One-shot lock after refund initiated');
{
  const o = baseOrder({
    returnInfo: {
      rtoStatus: 'pending',
      rtoWarehouseDeliveredAt: new Date('2026-01-01T00:00:00Z'),
      rtoReasonCategory: 'courier',
      rtoRefundId: 'rfnd_done',
      refundInitiatedAt: new Date()
    }
  });
  assert('locked full', canOfferFullPaidAmountRtoRefund(o) === false);
  assert('locked net', canOfferStandardRtoRefund(o) === false);
}

console.log(`\nDone: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
