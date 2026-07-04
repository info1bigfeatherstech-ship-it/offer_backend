/**
 * Unit tests for RTO notification message selection (no DB).
 * Run: node backend/scripts/test-rto-notifications.js
 */
process.env.RTO_MIN_ORDER_VALUE_FOR_REFUND = '100';
process.env.RTO_MIN_REFUND_THRESHOLD = '20';
process.env.RTO_REFUND_POLICY_URL = 'https://offerwalebaba.com/policies/return-refund';
process.env.RTO_PLATFORM_FEE_TIERS = JSON.stringify([
  { min: 100, max: 200, percent: 8, cap: 16 },
  { min: 201, max: 500, percent: 6, cap: 30 },
  { min: 501, max: 1000, percent: 5, cap: 50 },
  { min: 1001, max: null, percent: 4.5, cap: 200 }
]);

const { resetPlatformFeeTiersCache } = require('../config/rtoPlatformFee.config');
resetPlatformFeeTiersCache();

const {
  buildRtoInitiatedPayload,
  buildRefundInitiatedPayload,
  buildRefundRejectedByAdminPayload,
  isRtoOrder
} = require('../services/rtoNotification.service');

const fullPaid = {
  paymentInfo: { method: 'online' },
  paymentStatus: 'paid',
  orderStatus: 'rto',
  shipmentInfo: { providerStatus: 'RTO Initiated' }
};

const cases = [
  {
    name: 'Eligible full paid',
    order: {
      ...fullPaid,
      orderId: 'OWB-TEST-001',
      subtotal: 800,
      deliveryCharges: 110,
      totalAmount: 910,
      amountPaidInr: 910
    },
    expectType: 'rto_initiated'
  },
  {
    name: 'COD',
    order: {
      orderId: 'OWB-TEST-002',
      orderStatus: 'rto',
      shipmentInfo: { providerStatus: 'RTO' },
      paymentInfo: { method: 'cod' },
      paymentStatus: 'pending',
      subtotal: 500,
      deliveryCharges: 40,
      totalAmount: 540
    },
    expectType: 'refund_not_applicable',
    expectReason: 'cod'
  },
  {
    name: 'Partial',
    order: {
      orderId: 'OWB-TEST-003',
      orderStatus: 'rto',
      shipmentInfo: { providerStatus: 'RTO' },
      paymentInfo: { method: 'online' },
      paymentStatus: 'partially_paid',
      subtotal: 1200,
      deliveryCharges: 0,
      totalAmount: 1200,
      amountPaidInr: 500
    },
    expectType: 'refund_not_applicable',
    expectReason: 'partial_payment'
  },
  {
    name: 'Below ₹100',
    order: {
      ...fullPaid,
      orderId: 'OWB-TEST-004',
      subtotal: 59,
      deliveryCharges: 40,
      totalAmount: 99,
      amountPaidInr: 99
    },
    expectType: 'refund_not_applicable',
    expectReason: 'order_below_min_value'
  },
  {
    name: 'Refund below threshold',
    order: {
      ...fullPaid,
      orderId: 'OWB-TEST-005',
      subtotal: 100,
      deliveryCharges: 20,
      totalAmount: 120,
      amountPaidInr: 120,
      returnInfo: { rtoDeductions: { rtoShipping: 70.4 } }
    },
    expectType: 'refund_not_applicable',
    expectReason: 'refund_below_min_threshold'
  },
  {
    name: 'Refund initiated payload',
    fn: () =>
      buildRefundInitiatedPayload(
        { orderId: 'OWB-X', subtotal: 800, deliveryCharges: 110 },
        704.5
      ),
    expectType: 'refund_initiated'
  },
  {
    name: 'Admin deny payload',
    fn: () => buildRefundRejectedByAdminPayload({ orderId: 'OWB-X', subtotal: 100, deliveryCharges: 20 }),
    expectType: 'refund_rejected'
  }
];

let failed = 0;
for (const c of cases) {
  if (c.fn) {
    const payload = c.fn();
    const ok = payload.type === c.expectType;
    if (!ok) failed += 1;
    console.log(c.name, ok ? 'PASS' : 'FAIL', '| type:', payload.type);
    continue;
  }
  if (!isRtoOrder(c.order)) {
    console.log(c.name, 'FAIL', 'isRtoOrder false');
    failed += 1;
    continue;
  }
  const payload = buildRtoInitiatedPayload(c.order);
  const typeOk = payload.type === c.expectType;
  const reasonOk = !c.expectReason || payload.metadata?.reason === c.expectReason;
  const policyOk = String(payload.body).includes('offerwalebaba.com/policies/return-refund') ||
    payload.type === 'rto_initiated';
  const ok = typeOk && reasonOk && policyOk;
  if (!ok) failed += 1;
  console.log(
    c.name,
    ok ? 'PASS' : 'FAIL',
    '| type:',
    payload.type,
    c.expectReason ? `| reason: ${payload.metadata?.reason}` : ''
  );
}

console.log(failed ? `\n${failed} failed` : '\nAll notification payload tests PASSED');
process.exit(failed ? 1 : 0);
