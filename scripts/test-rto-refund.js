/**
 * RTO v3 refund calculation tests — platform fee on order total (subtotal + delivery).
 * Run: node backend/scripts/test-rto-refund.js
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

const { calculateRtoRefund } = require('../services/rtoRefund.service');

const fullPaidOnline = {
  paymentInfo: { method: 'online' },
  paymentStatus: 'paid'
};

function paidOrder(subtotal, deliveryCharges, amountPaidInr) {
  return {
    ...fullPaidOnline,
    subtotal,
    deliveryCharges,
    totalAmount: amountPaidInr,
    amountPaidInr
  };
}

const cases = [
  {
    name: 'Ex1 — ₹910 order → ₹704.50',
    order: paidOrder(800, 110, 910),
    rto: 50,
    expectEligible: true,
    expectNet: 704.5,
    expectReason: 'full_online_payment'
  },
  {
    name: 'Ex2 — ₹99 order → no refund (below ₹100)',
    order: paidOrder(59, 40, 99),
    rto: 0,
    expectEligible: false,
    expectNet: 0,
    expectReason: 'order_below_min_value'
  },
  {
    name: 'Ex3 — ₹240 order → ₹155.60',
    order: paidOrder(200, 40, 240),
    rto: 30,
    expectEligible: true,
    expectNet: 155.6,
    expectReason: 'full_online_payment'
  },
  {
    name: 'Ex4 — ₹1250 order → ₹1103.75',
    order: paidOrder(1200, 50, 1250),
    rto: 40,
    expectEligible: true,
    expectNet: 1103.75,
    expectReason: 'full_online_payment'
  },
  {
    name: 'Ex5 — ₹190 order → ₹104.80',
    order: paidOrder(150, 40, 190),
    rto: 30,
    expectEligible: true,
    expectNet: 104.8,
    expectReason: 'full_online_payment'
  },
  {
    name: 'Ex6 — partial payment → no refund',
    order: {
      subtotal: 1200,
      deliveryCharges: 0,
      totalAmount: 1200,
      paymentInfo: { method: 'online' },
      paymentStatus: 'partially_paid',
      amountPaidInr: 500
    },
    expectEligible: false,
    expectNet: 0,
    expectReason: 'partial_or_unpaid_no_refund'
  },
  {
    name: 'Ex7 — same as Ex5 (above ₹20 threshold)',
    order: paidOrder(150, 40, 190),
    rto: 30,
    expectEligible: true,
    expectNet: 104.8,
    expectReason: 'full_online_payment'
  },
  {
    name: 'Ex8 — ₹140 order, heavy RTO → ₹28.80',
    order: paidOrder(120, 20, 140),
    rto: 80,
    expectEligible: true,
    expectNet: 28.8,
    expectReason: 'full_online_payment'
  },
  {
    name: 'Ex9 — ₹110 order → ₹21.20',
    order: paidOrder(80, 30, 110),
    rto: 50,
    expectEligible: true,
    expectNet: 21.2,
    expectReason: 'full_online_payment'
  },
  {
    name: 'Ex10 — COD → no refund',
    order: {
      subtotal: 1500,
      deliveryCharges: 0,
      totalAmount: 1500,
      paymentInfo: { method: 'cod' },
      paymentStatus: 'pending',
      amountPaidInr: 0
    },
    expectEligible: false,
    expectNet: 0,
    expectReason: 'cod_no_refund'
  },
  {
    name: 'Ex11 — net refund exactly ₹20 → blocked',
    order: paidOrder(100, 20, 120),
    rto: 70.4,
    expectEligible: false,
    expectNet: 20,
    expectReason: 'refund_below_min_threshold'
  },
  {
    name: 'Ex12 — net refund ₹20.01 → allowed',
    order: paidOrder(100, 20, 120),
    rto: 70.39,
    expectEligible: true,
    expectNet: 20.01,
    expectReason: 'full_online_payment'
  }
];

let failed = 0;
for (const c of cases) {
  const r = calculateRtoRefund(c.order, { rtoShippingOverride: c.rto });
  const netOk = r.netRefund === c.expectNet;
  const eligOk = r.eligible === c.expectEligible;
  const reasonOk = r.reason === c.expectReason;
  const ok = netOk && eligOk && reasonOk;
  if (!ok) failed += 1;
  console.log(
    c.name,
    ok ? 'PASS' : 'FAIL',
    '| net:',
    r.netRefund,
    'expected',
    c.expectNet,
    '| eligible:',
    r.eligible,
    'expected',
    c.expectEligible,
    '| reason:',
    r.reason,
    reasonOk ? '' : `(expected ${c.expectReason})`
  );
  if (!ok && r.deductions) {
    console.log('  deductions:', JSON.stringify(r.deductions));
  }
}

console.log(failed ? `\n${failed} test(s) FAILED` : '\nAll tests PASSED');
process.exit(failed ? 1 : 0);
