/**
 * Seed / cleanup local RTO test orders for admin RTO tab QA.
 *
 * Usage (from backend/):
 *   node scripts/seed-rto-test-orders.js           # create 5 test RTO orders
 *   node scripts/seed-rto-test-orders.js --cleanup # delete seeded orders
 *   node scripts/seed-rto-test-orders.js --verify  # list + refund calc only
 *
 * Covers: RTO Initiated / In Transit / Delivered to warehouse × Full vs Partial paid.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const Order = require('../models/Order');
const {
  calculateRtoRefund,
  calculatePlatformFee,
  mapShiprocketRtoStage,
  classifyRtoPaymentType,
  isRtoDeliveredToWarehouse
} = require('../services/rtoRefund.service');

const SEED_TAG = 'rto_test_seed_v1';
const ORDER_IDS = [
  'OWB-ECOMM-RTOTEST0001',
  'OWB-ECOMM-RTOTEST0002',
  'OWB-ECOMM-RTOTEST0003',
  'OWB-ECOMM-RTOTEST0004',
  'OWB-ECOMM-RTOTEST0005'
];

const SPECS = [
  {
    orderId: ORDER_IDS[0],
    label: 'Full paid — RTO Initiated — customer refusal',
    subtotal: 1200,
    deliveryCharges: 60,
    tax: 0,
    totalAmount: 1260,
    paymentStatus: 'paid',
    amountPaidInr: 1260,
    balanceDueInr: 0,
    paymentInfo: {
      method: 'online',
      splitMode: 'full',
      razorpayPaymentId: 'pay_rto_test_0001',
      _rtoTestSeed: SEED_TAG
    },
    providerStatus: 'RTO - Customer refused to accept delivery',
    rtoFreightCharge: 40,
    addressSnapshot: { name: 'RTO Test Rahul', phone: '9876500001', fullName: 'RTO Test Rahul' }
  },
  {
    orderId: ORDER_IDS[1],
    label: 'Full paid — RTO In Transit — wrong address',
    subtotal: 500,
    deliveryCharges: 40,
    tax: 0,
    totalAmount: 540,
    paymentStatus: 'paid',
    amountPaidInr: 540,
    balanceDueInr: 0,
    paymentInfo: {
      method: 'online',
      splitMode: 'full',
      razorpayPaymentId: 'pay_rto_test_0002',
      _rtoTestSeed: SEED_TAG
    },
    providerStatus: 'RTO In Transit - Wrong address / delivery failed',
    rtoFreightCharge: 30,
    addressSnapshot: { name: 'RTO Test Priya', phone: '9876500002', fullName: 'RTO Test Priya' }
  },
  {
    orderId: ORDER_IDS[2],
    label: 'Full paid — RTO Delivered to warehouse — refund allowed',
    subtotal: 1200,
    deliveryCharges: 60,
    tax: 0,
    totalAmount: 1260,
    paymentStatus: 'paid',
    amountPaidInr: 1260,
    balanceDueInr: 0,
    paymentInfo: {
      method: 'online',
      splitMode: 'full',
      razorpayPaymentId: 'pay_rto_test_0003',
      _rtoTestSeed: SEED_TAG
    },
    providerStatus: 'RTO Delivered to warehouse - Wrong address / delivery failed',
    rtoFreightCharge: 40,
    addressSnapshot: { name: 'RTO Test Vikram', phone: '9876500003', fullName: 'RTO Test Vikram' }
  },
  {
    orderId: ORDER_IDS[3],
    label: 'Partial paid — RTO Initiated — no refund button',
    subtotal: 2000,
    deliveryCharges: 80,
    tax: 0,
    totalAmount: 2080,
    paymentStatus: 'partially_paid',
    amountPaidInr: 500,
    balanceDueInr: 1580,
    paymentInfo: {
      method: 'online',
      splitMode: 'advance',
      advancePercent: 25,
      balanceCollectionMethod: 'cod',
      razorpayPaymentId: 'pay_rto_test_0004',
      _rtoTestSeed: SEED_TAG
    },
    providerStatus: 'RTO - Customer not available',
    rtoFreightCharge: 50,
    addressSnapshot: { name: 'RTO Test Amit', phone: '9876500004', fullName: 'RTO Test Amit' }
  },
  {
    orderId: ORDER_IDS[4],
    label: 'Partial paid — RTO Delivered to warehouse — resolve only',
    subtotal: 1500,
    deliveryCharges: 60,
    tax: 0,
    totalAmount: 1560,
    paymentStatus: 'partially_paid',
    amountPaidInr: 400,
    balanceDueInr: 1160,
    paymentInfo: {
      method: 'online',
      splitMode: 'advance',
      advancePercent: 25,
      balanceCollectionMethod: 'online',
      razorpayPaymentId: 'pay_rto_test_0005',
      _rtoTestSeed: SEED_TAG
    },
    providerStatus: 'RTO Delivered to warehouse - Undelivered / address issue',
    rtoFreightCharge: 45,
    addressSnapshot: { name: 'RTO Test Sneha', phone: '9876500005', fullName: 'RTO Test Sneha' }
  }
];

function buildLineItem(templateItem, subtotal) {
  const item = templateItem
    ? { ...templateItem }
    : {
        productId: new mongoose.Types.ObjectId(),
        quantity: 1,
        priceSnapshot: { base: subtotal, sale: null, total: subtotal },
        variantAttributesSnapshot: [],
        userType: 'normal',
        hsnCode: null,
        gstRate: null,
        isFragile: false
      };
  if (!templateItem) return item;
  item.priceSnapshot = { base: subtotal, sale: null, total: subtotal };
  item.quantity = 1;
  return item;
}

function buildOrderDoc(spec, template) {
  const item = buildLineItem(template?.items?.[0], spec.subtotal);
  const { fee: platformFee, percent: platformFeePercent } = calculatePlatformFee(spec.subtotal);
  const rtoDeductions = {
    forwardShipping: spec.deliveryCharges,
    rtoShipping: spec.rtoFreightCharge,
    platformFee,
    platformFeePercent
  };
  return {
    orderId: spec.orderId,
    userId: template.userId,
    items: [item],
    subtotal: spec.subtotal,
    deliveryCharges: spec.deliveryCharges,
    tax: spec.tax,
    discount: 0,
    totalAmount: spec.totalAmount,
    address: template.address,
    addressSnapshot: { ...(template.addressSnapshot || {}), ...spec.addressSnapshot },
    userType: template.userType || 'normal',
    storefront: template.storefront || 'ecomm',
    orderStatus: 'rto',
    paymentStatus: spec.paymentStatus,
    amountPaidInr: spec.amountPaidInr,
    balanceDueInr: spec.balanceDueInr,
    paymentInfo: spec.paymentInfo,
    refundHistory: [],
    shipmentInfo: {
      shipmentId: `SR-TEST-${spec.orderId.slice(-4)}`,
      awbCode: `AWB${spec.orderId.slice(-6)}`,
      trackingNumber: `AWB${spec.orderId.slice(-6)}`,
      courier: 'Delhivery Surface (Test)',
      providerStatus: spec.providerStatus,
      shippedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
      lastSyncAt: new Date(),
      lastSyncSource: 'rto_test_seed',
      deliveredAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000)
    },
    returnInfo: {
      rtoStatus: 'pending',
      rtoDeductions,
      rtoHistory: [
        {
          action: 'seeded',
          note: spec.label,
          performedBy: null,
          createdAt: new Date(),
          metadata: { seedTag: SEED_TAG, stage: mapShiprocketRtoStage(spec.providerStatus) }
        }
      ]
    }
  };
}

async function getTemplateOrder() {
  const existing = await Order.findOne({
    storefront: 'ecomm',
    userId: { $exists: true },
    address: { $exists: true },
    'items.0': { $exists: true },
    orderId: { $not: /^OWB-ECOMM-RTOTEST/ }
  })
    .sort({ createdAt: -1 })
    .lean();

  if (existing) return existing;

  const any = await Order.findOne({
    userId: { $exists: true },
    address: { $exists: true },
    orderId: { $not: /^OWB-ECOMM-RTOTEST/ }
  })
    .sort({ createdAt: -1 })
    .lean();
  if (!any) {
    throw new Error('No existing order in DB to use as template (need userId + address).');
  }
  return any;
}

async function cleanup() {
  const res = await Order.deleteMany({
    $or: [{ orderId: { $in: ORDER_IDS } }, { 'paymentInfo._rtoTestSeed': SEED_TAG }]
  });
  console.log(`\n🗑️  Deleted ${res.deletedCount} RTO test order(s).`);
}

function canRefundPreview(order, calc) {
  const ri = order.returnInfo || {};
  const warehouse = isRtoDeliveredToWarehouse(order.shipmentInfo?.providerStatus);
  const rtoStatus = ri.rtoStatus || 'pending';
  return (
    calc.eligible &&
    warehouse &&
    ['pending', null].includes(rtoStatus) &&
    !ri.rtoResolvedAt
  );
}

async function verify() {
  const orders = await Order.find({
    $or: [{ orderId: { $in: ORDER_IDS } }, { 'paymentInfo._rtoTestSeed': SEED_TAG }]
  })
    .sort({ orderId: 1 })
    .lean();

  if (!orders.length) {
    console.log('\n⚠️  No RTO test orders found. Run without --verify to seed.');
    return;
  }

  console.log(`\n✅ Found ${orders.length} RTO test order(s):\n`);
  for (const o of orders) {
    const calc = calculateRtoRefund(o);
    const stage = mapShiprocketRtoStage(o.shipmentInfo?.providerStatus);
    const pay = classifyRtoPaymentType(o);
    const canRefund = canRefundPreview(o, calc);
    console.log('─'.repeat(64));
    console.log(`Order:      ${o.orderId}`);
    console.log(`Scenario:   ${o.returnInfo?.rtoHistory?.[0]?.note || '—'}`);
    console.log(`Payment:    ${pay.label} — ${pay.detail}`);
    console.log(`Shiprocket: ${o.shipmentInfo?.providerStatus}`);
    console.log(`RTO stage:  ${stage}`);
    console.log(`Refund btn: ${canRefund ? 'YES ✅' : 'NO ❌'} | net=₹${calc.netRefund}`);
  }
  console.log('─'.repeat(64));
  console.log('\nExpected: only RTOTEST0003 shows Refund button in admin UI.\n');
}

async function seed() {
  const template = await getTemplateOrder();
  console.log(`Using template order ${template.orderId} (userId ${template.userId})`);

  let created = 0;
  let updated = 0;

  for (const spec of SPECS) {
    const doc = buildOrderDoc(spec, template);
    const existing = await Order.findOne({ orderId: spec.orderId });
    if (existing) {
      await Order.updateOne({ orderId: spec.orderId }, { $set: doc });
      updated += 1;
      console.log(`↻ Updated ${spec.orderId} — ${spec.label}`);
    } else {
      await Order.create(doc);
      created += 1;
      console.log(`✚ Created ${spec.orderId} — ${spec.label}`);
    }
  }

  console.log(`\nDone: ${created} created, ${updated} updated.`);
  await verify();
  console.log('Before deploy: node scripts/seed-rto-test-orders.js --cleanup');
}

async function main() {
  const uri = process.env.MONGO_DB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_DB_URI is not set in backend/.env');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const cleanupMode = args.includes('--cleanup') || args.includes('cleanup');
  const verifyOnly = args.includes('--verify') || args.includes('verify');

  await mongoose.connect(uri);
  console.log('Connected to MongoDB');

  try {
    if (cleanupMode) await cleanup();
    else if (verifyOnly) await verify();
    else await seed();
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
