/**
 * Unit tests — admin Pickup Exception bucketing + list STATUS labels.
 * Run: node scripts/test-pickup-exception-admin-bucket.js
 */
const assert = require('assert');
const {
  isPickupExceptionProviderStatus,
  isPickupExceptionAdminBucketOrder,
  buildPickupExceptionBucketMatch,
  buildPickupExceptionExclusionForNonExceptionBucket,
  fulfillmentLabelForPickupExceptionAwareOrder
} = require('../constants/pickupExceptionOrderQuery');
const {
  fulfillmentLabelForAdminListRow,
  fulfillmentLabelFromOrderStatus
} = require('../constants/adminOrderFulfillmentBuckets');
const {
  buildBucketMatch,
  mapOrderRow
} = require('../services/adminOrderDashboard.service');
const { classifySignalTexts, CLASSIFICATION } = require('../services/shipmentOps/normalizeProviderSignals');

function testProviderStatusDetection() {
  assert.strictEqual(isPickupExceptionProviderStatus('Pickup Exception'), true);
  assert.strictEqual(isPickupExceptionProviderStatus('PICKUP EXCEPTION'), true);
  assert.strictEqual(isPickupExceptionProviderStatus('Pickup Failed'), true);
  assert.strictEqual(isPickupExceptionProviderStatus('Wrong courier'), true);
  assert.strictEqual(isPickupExceptionProviderStatus('PICKUP SCHEDULED'), false);
  assert.strictEqual(isPickupExceptionProviderStatus('RTO Delivered'), false);
  assert.strictEqual(isPickupExceptionProviderStatus(''), false);
  assert.strictEqual(isPickupExceptionProviderStatus(null), false);
}

function testAdminBucketOrder() {
  assert.strictEqual(
    isPickupExceptionAdminBucketOrder({
      orderStatus: 'processing',
      shipmentInfo: { providerStatus: 'Pickup Exception' }
    }),
    true
  );
  assert.strictEqual(
    isPickupExceptionAdminBucketOrder({
      orderStatus: 'confirmed',
      shipmentInfo: { providerStatus: 'Pickup Exception' }
    }),
    true
  );
  assert.strictEqual(
    isPickupExceptionAdminBucketOrder({
      orderStatus: 'pickup_exception',
      shipmentInfo: { providerStatus: null }
    }),
    true
  );
  assert.strictEqual(
    isPickupExceptionAdminBucketOrder({
      orderStatus: 'processing',
      shipmentInfo: { providerStatus: 'PICKUP SCHEDULED' }
    }),
    false
  );
  assert.strictEqual(
    isPickupExceptionAdminBucketOrder({
      orderStatus: 'rto',
      shipmentInfo: { providerStatus: 'Pickup Exception' }
    }),
    false
  );
  assert.strictEqual(
    isPickupExceptionAdminBucketOrder({
      orderStatus: 'processing',
      shipmentInfo: { providerStatus: 'RTO Initiated' }
    }),
    false
  );
  assert.strictEqual(
    isPickupExceptionAdminBucketOrder({
      orderStatus: 'shipped',
      shipmentInfo: { providerStatus: 'Pickup Exception' }
    }),
    false
  );
}

function testBucketMatchShape() {
  const pe = buildPickupExceptionBucketMatch();
  assert.ok(pe.$and);
  assert.ok(Array.isArray(pe.$and));

  const ready = buildBucketMatch('ready_to_ship');
  assert.ok(ready.$and, 'ready_to_ship must $and exclusion filters');
  const readyJson = JSON.stringify(ready);
  assert.ok(readyJson.includes('pickup'), 'ready_to_ship must exclude pickup exception providerStatus');

  const pick = buildBucketMatch('ready_to_pick');
  assert.ok(JSON.stringify(pick).includes('pickup'));

  const confirmed = buildBucketMatch('bill_sent');
  assert.ok(JSON.stringify(confirmed).includes('pickup'));

  const peBucket = buildBucketMatch('pickup_exception');
  assert.deepStrictEqual(peBucket, pe);

  assert.strictEqual(buildPickupExceptionExclusionForNonExceptionBucket('in_transit'), null);
  assert.ok(buildPickupExceptionExclusionForNonExceptionBucket('ready_to_ship'));
}

function testListLabels() {
  assert.strictEqual(
    fulfillmentLabelForPickupExceptionAwareOrder('processing', 'Pickup Exception'),
    'Pickup Exception'
  );
  assert.strictEqual(
    fulfillmentLabelForAdminListRow('processing', 'PICKUP SCHEDULED', 'ready_to_ship'),
    'Ready to Ship'
  );
  assert.strictEqual(
    fulfillmentLabelForAdminListRow('processing', 'PICKUP SCHEDULED', 'ready_to_pick'),
    'Processing'
  );
  assert.strictEqual(
    fulfillmentLabelForAdminListRow('processing', 'Pickup Exception', 'ready_to_ship'),
    'Pickup Exception'
  );
  assert.strictEqual(
    fulfillmentLabelFromOrderStatus('pickup_exception', null),
    'Pickup Exception'
  );
}

function testMapOrderRowBucketsAndLabels() {
  const exceptionRow = mapOrderRow({
    orderId: 'OWB-ECOMM-TEST-PE',
    orderStatus: 'processing',
    paymentStatus: 'paid',
    paymentInfo: { method: 'online' },
    totalAmount: 100,
    items: [{ productId: '1' }],
    addressSnapshot: { phone: '9876543210' },
    shipmentInfo: {
      awbCode: 'AWB1',
      shipmentId: '1',
      shiprocketOrderId: '2',
      providerStatus: 'Pickup Exception',
      courier: 'Delhivery Surface',
      manifestDownloaded: false,
      labelDownloaded: false
    },
    createdAt: new Date()
  });
  assert.strictEqual(exceptionRow.fulfillmentBucket, 'pickup_exception');
  assert.strictEqual(exceptionRow.fulfillmentLabel, 'Pickup Exception');
  assert.strictEqual(exceptionRow.orderStatus, 'processing', 'DB orderStatus must stay processing');
  assert.strictEqual(exceptionRow.opsState, 'PICKUP_EXCEPTION');
  assert.strictEqual(exceptionRow.primaryAction, 'retryPickup');
  assert.strictEqual(exceptionRow.actionCapabilities.retryPickup, true);

  const readyRow = mapOrderRow({
    orderId: 'OWB-ECOMM-TEST-RTS',
    orderStatus: 'processing',
    paymentStatus: 'partially_paid',
    paymentInfo: { method: 'cod' },
    totalAmount: 200,
    items: [{ productId: '1' }, { productId: '2' }],
    addressSnapshot: { phone: '9876543210' },
    shipmentInfo: {
      awbCode: 'AWB2',
      shipmentId: '3',
      shiprocketOrderId: '4',
      providerStatus: 'PICKUP SCHEDULED',
      pickupDate: '2026-07-12',
      courier: 'Delhivery Air',
      manifestDownloaded: false,
      labelDownloaded: true
    },
    createdAt: new Date()
  });
  assert.strictEqual(readyRow.fulfillmentBucket, 'ready_to_ship');
  assert.strictEqual(readyRow.fulfillmentLabel, 'Ready to Ship');
  assert.notStrictEqual(readyRow.opsState, 'PICKUP_EXCEPTION');

  const processingRow = mapOrderRow({
    orderId: 'OWB-ECOMM-TEST-PICK',
    orderStatus: 'processing',
    paymentStatus: 'paid',
    paymentInfo: { method: 'online' },
    totalAmount: 50,
    items: [],
    addressSnapshot: {},
    shipmentInfo: {
      awbCode: 'AWB3',
      shipmentId: '5',
      shiprocketOrderId: '6',
      providerStatus: 'PICKUP SCHEDULED',
      manifestDownloaded: true,
      labelDownloaded: true
    },
    createdAt: new Date()
  });
  assert.strictEqual(processingRow.fulfillmentBucket, 'ready_to_pick');
  assert.strictEqual(processingRow.fulfillmentLabel, 'Processing');
}

function testSignalClassificationStillAligned() {
  assert.strictEqual(
    classifySignalTexts(['pickup exception']),
    CLASSIFICATION.PICKUP_EXCEPTION
  );
  assert.strictEqual(
    classifySignalTexts(['wrong courier at warehouse']),
    CLASSIFICATION.PICKUP_EXCEPTION
  );
  assert.strictEqual(classifySignalTexts(['pickup scheduled']), CLASSIFICATION.PICKUP_SCHEDULED);
}

function run() {
  testProviderStatusDetection();
  testAdminBucketOrder();
  testBucketMatchShape();
  testListLabels();
  testMapOrderRowBucketsAndLabels();
  testSignalClassificationStillAligned();
  console.log('All pickup-exception admin bucket tests passed.');
}

run();
