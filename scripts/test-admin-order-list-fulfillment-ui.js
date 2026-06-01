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
    fulfillmentPaymentGate: { ok: true, reason: 'paid' },
    shipmentInfo: {
      awbCode: '369445882047',
      shipmentId: '1',
      shiprocketOrderId: '2',
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
    fulfillmentPaymentGate: { ok: true, reason: 'paid' },
    shipmentInfo: {}
  });
  assert.strictEqual(ops.line1, 'Ready to ship');
  const caps = buildRowActionCapabilities({
    orderStatus: 'confirmed',
    fulfillmentPaymentGate: { ok: true, reason: 'paid' },
    shipmentInfo: {}
  });
  assert.strictEqual(caps.shipNow, true);
  assert.strictEqual(caps.schedulePickup, false);
}

function testListRowUi() {
  const ui = buildListRowFulfillmentUi({
    orderStatus: 'processing',
    fulfillmentPaymentGate: { ok: true, reason: 'paid' },
    shipmentInfo: {
      awbCode: 'AWB1',
      shipmentId: '1',
      shiprocketOrderId: '2',
      courier: 'Amazon',
      pickupDate: '2026-05-18',
      providerStatus: 'PICKUP SCHEDULED'
    }
  });
  assert.strictEqual(ui.primaryAction, 'generateManifest');
  assert.strictEqual(ui.actionCapabilities.generateManifest, true);
  assert.strictEqual(ui.actionCapabilities.downloadManifest, false);
}

function testPickupExceptionListUi() {
  const ui = buildListRowFulfillmentUi({
    orderStatus: 'processing',
    fulfillmentPaymentGate: { ok: true, reason: 'paid' },
    shipmentInfo: {
      awbCode: 'AWB1',
      shipmentId: '1',
      shiprocketOrderId: '2',
      pickupDate: '2026-05-18',
      providerStatus: 'Pickup Exception'
    }
  });
  assert.strictEqual(ui.courierOpsLine1, 'Pickup exception — action required');
  assert.strictEqual(ui.actionCapabilities.generateManifest, false);
  assert.strictEqual(ui.actionCapabilities.retryPickup, true);
  assert.strictEqual(ui.primaryAction, 'retryPickup');
}

function run() {
  testProcessingPickupScheduled();
  testConfirmedReadyToShip();
  testListRowUi();
  testPickupExceptionListUi();
  console.log('All admin order list fulfillment UI tests passed.');
}

run();
