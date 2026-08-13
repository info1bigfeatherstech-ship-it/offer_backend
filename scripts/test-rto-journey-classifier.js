/**
 * RTO journey classifier — customer Delivered vs RTO Delivered.
 * Run: node scripts/test-rto-journey-classifier.js
 */
const assert = require('assert');
const {
  canClearFalseRtoLatch,
  hasCourierRtoEvidence,
  classifyRtoJourney,
  resolveRtoDisplayLabel
} = require('../services/shipmentOps/rtoJourneyClassifier');
const {
  repairOrderStatusForFalseRtoLatch,
  repairOrderStatusForShiprocketRto,
  canApplyProviderOrderStatus,
  fulfillmentLabelForRtoAwareOrder
} = require('../constants/rtoOrderQuery');

function testNeverDemotesRtoDeliveredLabels() {
  const labels = [
    'RTO Delivered',
    'RTO Delivered to warehouse',
    'RTO IN TRANSIT',
    'RTO Initiated',
    'Return To Seller',
    'Returned to Seller',
    'RTS',
    'rts_d'
  ];
  for (const providerStatus of labels) {
    const order = {
      orderStatus: 'rto',
      shipmentInfo: { providerStatus, rawEvents: [{ status: providerStatus }] }
    };
    assert.strictEqual(canClearFalseRtoLatch(order), false, providerStatus);
    assert.strictEqual(repairOrderStatusForFalseRtoLatch({ ...order, shipmentInfo: { ...order.shipmentInfo } }), false, providerStatus);
    assert.strictEqual(order.orderStatus, 'rto', providerStatus);
  }
}

function testPromoteStillWorksForLiveRtoLabel() {
  const order = {
    orderStatus: 'delivered',
    shipmentInfo: { providerStatus: 'RTO Delivered' }
  };
  assert.strictEqual(repairOrderStatusForShiprocketRto(order), true);
  assert.strictEqual(order.orderStatus, 'rto');
}

function testMalformedOrderDoesNotThrow() {
  assert.doesNotThrow(() => canClearFalseRtoLatch(null));
  assert.doesNotThrow(() => canClearFalseRtoLatch(undefined));
  assert.doesNotThrow(() => hasCourierRtoEvidence({ shipmentInfo: null, returnInfo: 'bad' }));
  assert.doesNotThrow(() => classifyRtoJourney({ shipmentInfo: { rawEvents: [null, 1, { status: {} }] } }));
  assert.doesNotThrow(() => resolveRtoDisplayLabel(null, null));
  assert.doesNotThrow(() => fulfillmentLabelForRtoAwareOrder('rto', null, null));
  assert.doesNotThrow(() => repairOrderStatusForFalseRtoLatch(null));
  assert.doesNotThrow(() => canApplyProviderOrderStatus('rto', 'delivered', 'Delivered', { shipmentInfo: null }));
}

function testClassifierKinds() {
  const sticky = classifyRtoJourney({
    orderStatus: 'rto',
    shipmentInfo: {
      providerStatus: 'Delivered',
      rawEvents: [{ status: 'RTO Initiated' }, { status: 'Delivered' }]
    }
  });
  assert.strictEqual(sticky.kind, 'rto');
  assert.strictEqual(sticky.canDemoteToDelivered, false);
  assert.strictEqual(sticky.displayLabel, 'RTO Delivered');

  const healed = classifyRtoJourney({
    orderStatus: 'rto',
    shipmentInfo: {
      providerStatus: 'Delivered',
      rawEvents: [{ status: 'Out for Delivery' }, { status: 'Delivered' }]
    }
  });
  assert.strictEqual(healed.kind, 'customer_delivered');
  assert.strictEqual(healed.canDemoteToDelivered, true);
}

function run() {
  testNeverDemotesRtoDeliveredLabels();
  testPromoteStillWorksForLiveRtoLabel();
  testMalformedOrderDoesNotThrow();
  testClassifierKinds();
  console.log('All RTO journey classifier tests passed.');
}

run();
