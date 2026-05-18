/**
 * Unit tests — admin order list courier ops + action capabilities.
 * Run: node scripts/test-admin-order-list-fulfillment-ui.js
 */
const assert = require('assert');
const {
  buildCourierOpsDisplay,
  buildRowActionCapabilities,
  buildListRowFulfillmentUi
} = require('../utils/adminOrderListFulfillmentUi');

function testProcessingPickupScheduled() {
  const ops = buildCourierOpsDisplay({
    orderStatus: 'processing',
    shipmentInfo: {
      awbCode: '369445882047',
      courier: 'Amazon Prepaid Surface 500g',
      pickupDate: '2026-05-18',
      providerStatus: 'PICKUP SCHEDULED'
    }
  });
  assert.strictEqual(ops.line1, 'Pickup scheduled');
  assert.ok(ops.line2.includes('18 May 2026'));
  assert.ok(ops.line2.includes('Amazon'));
}

function testConfirmedReadyToShip() {
  const ops = buildCourierOpsDisplay({
    orderStatus: 'confirmed',
    shipmentInfo: {}
  });
  assert.strictEqual(ops.line1, 'Ready to ship');
  const caps = buildRowActionCapabilities({
    orderStatus: 'confirmed',
    hasAwb: false,
    hasShipmentId: false,
    pickupScheduled: false,
    canConfirmForFulfillment: false
  });
  assert.strictEqual(caps.shipNow, true);
  assert.strictEqual(caps.schedulePickup, false);
}

function testListRowUi() {
  const ui = buildListRowFulfillmentUi({
    orderStatus: 'processing',
    hasAwb: true,
    hasShipmentId: true,
    hasManifest: false,
    hasLabel: false,
    hasShiprocketOrderId: true,
    pickupScheduled: true,
    pickupDate: '2026-05-18',
    shipmentInfo: {
      awbCode: 'AWB1',
      courier: 'Amazon',
      pickupDate: '2026-05-18',
      providerStatus: 'PICKUP SCHEDULED'
    }
  });
  assert.strictEqual(ui.primaryAction, 'generateManifest');
  assert.strictEqual(ui.actionCapabilities.generateManifest, true);
  assert.strictEqual(ui.actionCapabilities.downloadManifest, false);
}

function run() {
  testProcessingPickupScheduled();
  testConfirmedReadyToShip();
  testListRowUi();
  console.log('All admin order list fulfillment UI tests passed.');
}

run();
