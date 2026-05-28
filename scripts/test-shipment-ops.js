/**
 * Unit tests — shipment ops engine.
 * Run: node scripts/test-shipment-ops.js
 */
const assert = require('assert');
const { computeOpsState } = require('../services/shipmentOps/computeOpsState');
const { buildShipmentOpsView } = require('../services/shipmentOps');
const { OPS_STATES } = require('../services/shipmentOps/constants');
const { buildListRowFulfillmentUi } = require('../utils/adminOrderListFulfillmentUi');

function testPickupExceptionState() {
  const order = {
    orderStatus: 'processing',
    shipmentInfo: {
      awbCode: '369445882047',
      shipmentId: '123',
      shiprocketOrderId: '999',
      courier: 'Amazon Prepaid Surface 500g',
      pickupDate: '2026-05-18',
      providerStatus: 'Pickup Exception',
      rawEvents: [{ status: 'Pickup Exception', description: 'Wrong courier at warehouse' }]
    }
  };
  assert.strictEqual(computeOpsState(order), OPS_STATES.PICKUP_EXCEPTION);
  const view = buildShipmentOpsView(order, {
    fulfillmentPaymentGate: { ok: true, reason: 'paid' }
  });
  assert.strictEqual(view.courierOpsLine1, 'Pickup exception — action required');
  assert.strictEqual(view.actionCapabilities.generateManifest, false);
  assert.strictEqual(view.actionCapabilities.retryPickup, true);
  assert.strictEqual(view.actionCapabilities.openShiprocketSupport, true);
  assert.strictEqual(view.primaryAction, 'retryPickup');
  assert.strictEqual(view.actionCapabilities.createTicket, undefined);
}

function testProviderResetState() {
  const order = {
    orderStatus: 'processing',
    shipmentInfo: {
      awbCode: 'AWBOLD',
      providerStatus: 'Auto cancel after 10 days',
      manifestUrl: 'https://example.com/old-manifest.pdf',
      labelUrl: 'https://example.com/old-label.pdf',
      pickupDate: '2026-05-10'
    }
  };
  assert.strictEqual(computeOpsState(order), OPS_STATES.PROVIDER_RESET);
  const view = buildShipmentOpsView(order, {
    fulfillmentPaymentGate: { ok: true, reason: 'paid' }
  });
  assert.strictEqual(view.actionCapabilities.shipNow, true);
  assert.strictEqual(view.actionCapabilities.generateManifest, false);
  assert.strictEqual(view.actionCapabilities.downloadManifest, false);
}

function testListUiPickupScheduled() {
  const ui = buildListRowFulfillmentUi({
    orderStatus: 'processing',
    canConfirmForFulfillment: false,
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
  assert.strictEqual(ui.courierOpsLine1, 'Pickup scheduled');
  assert.strictEqual(ui.primaryAction, 'generateManifest');
}

function testAwaitingApproval() {
  const view = buildShipmentOpsView({
    orderStatus: 'pending',
    shipmentInfo: {}
  });
  assert.strictEqual(view.opsState, OPS_STATES.AWAITING_APPROVAL);
  assert.strictEqual(view.actionCapabilities.accept, false);
}

function run() {
  testPickupExceptionState();
  testProviderResetState();
  testListUiPickupScheduled();
  testAwaitingApproval();
  console.log('All shipment ops tests passed.');
}

run();
