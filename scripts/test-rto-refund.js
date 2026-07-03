process.env.RTO_PLATFORM_FEE_TIERS = JSON.stringify([
  { min: 0, max: 500, percent: 6, cap: 30 },
  { min: 501, max: 1000, percent: 5.5, cap: 55 },
  { min: 1001, max: 1500, percent: 5, cap: 75 },
  { min: 1501, max: 2000, percent: 4.5, cap: 90 },
  { min: 2001, max: 3000, percent: 4, cap: 120 },
  { min: 3001, max: null, percent: 3.5, cap: 200 }
]);

const { calculateRtoRefund } = require('../services/rtoRefund.service');

const cases = [
  {
    name: 'TC1',
    order: {
      subtotal: 1200,
      totalAmount: 1260,
      deliveryCharges: 60,
      paymentInfo: { method: 'online' },
      paymentStatus: 'paid',
      amountPaidInr: 1260
    },
    rto: 40,
    expect: 1040
  },
  {
    name: 'TC2',
    order: {
      subtotal: 500,
      totalAmount: 540,
      deliveryCharges: 40,
      paymentInfo: { method: 'online' },
      paymentStatus: 'paid',
      amountPaidInr: 540
    },
    rto: 30,
    expect: 400
  },
  {
    name: 'TC3',
    order: {
      subtotal: 2000,
      totalAmount: 2000,
      deliveryCharges: 0,
      paymentInfo: { method: 'online' },
      paymentStatus: 'partially_paid',
      amountPaidInr: 500
    },
    expect: 0
  },
  {
    name: 'TC4',
    order: {
      subtotal: 1500,
      totalAmount: 1500,
      deliveryCharges: 0,
      paymentInfo: { method: 'cod' },
      paymentStatus: 'pending'
    },
    expect: 0
  },
  {
    name: 'TC5',
    order: {
      subtotal: 3000,
      totalAmount: 3080,
      deliveryCharges: 80,
      paymentInfo: { method: 'online' },
      paymentStatus: 'paid',
      amountPaidInr: 3080
    },
    rto: 50,
    expect: 2750
  }
];

let failed = 0;
for (const c of cases) {
  const r = calculateRtoRefund(c.order, { rtoShippingOverride: c.rto });
  const ok = r.netRefund === c.expect;
  if (!ok) failed += 1;
  console.log(c.name, ok ? 'PASS' : 'FAIL', 'got', r.netRefund, 'expected', c.expect, r.reason || '');
}
process.exit(failed ? 1 : 0);
