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
  assert.strictEqual(ui.courierOpsLine1, 'PICKUP SCHEDULED');
  assert.match(String(ui.courierOpsLine2 || ''), /For 18 May 2026/);
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

function testProviderResetFromSnapshotWhenStillNew() {
  const order = {
    orderStatus: 'processing',
    shipmentInfo: {
      awbCode: 'AWBOLD',
      providerStatus: 'NEW',
      providerSnapshot: {
        resetDetected: true,
        resetReason: 'Shipment auto-cancelled due to no pickup done in 10 days',
        statusLabel: 'NEW'
      }
    }
  };
  assert.strictEqual(computeOpsState(order), OPS_STATES.PROVIDER_RESET);
}

function testProviderResetSnapshotIgnoredAfterReship() {
  const order = {
    orderStatus: 'processing',
    shipmentInfo: {
      awbCode: '14112362507328',
      shipmentId: '123',
      shiprocketOrderId: '999',
      courier: 'Xpressbees Surface',
      pickupDate: '2026-05-30',
      manifestUrl: 'https://example.com/manifest.pdf',
      labelUrl: 'https://example.com/label.pdf',
      fulfillmentManifestAwb: '14112362507328',
      fulfillmentLabelAwb: '14112362507328',
      providerStatus: 'Pickup Generated',
      providerSnapshot: {
        resetDetected: true,
        resetReason: 'Shipment auto-cancelled due to no pickup done in 10 days',
        statusLabel: 'NEW',
        pickupScheduled: true
      }
    }
  };
  assert.strictEqual(computeOpsState(order), OPS_STATES.LABEL_READY);
  const view = buildShipmentOpsView(order, {
    fulfillmentPaymentGate: { ok: true, reason: 'paid' }
  });
  assert.strictEqual(view.actionCapabilities.downloadLabel, true);
  assert.strictEqual(view.actionCapabilities.downloadManifest, true);
  assert.strictEqual(view.actionCapabilities.shipNow, false);
}

function testOutForPickupKeepsLabelAndManifestDownloads() {
  const order = {
    orderStatus: 'processing',
    shipmentInfo: {
      awbCode: '14112362507328',
      shipmentId: '1346591722',
      shiprocketOrderId: '1350319109',
      courier: 'Xpressbees Surface',
      pickupDate: '2026-05-30',
      pickupScheduledAt: new Date('2026-05-29'),
      manifestUrl: 'https://example.com/manifest.pdf',
      labelUrl: 'https://example.com/label.pdf',
      fulfillmentManifestAwb: '14112362507328',
      fulfillmentLabelAwb: '14112362507328',
      providerStatus: 'Out For Pickup',
      rawEvents: [
        { status: 'OFP', description: 'Out For Pickup', at: '2026-05-30' },
        { status: 'DRC', description: 'Data Received', at: '2026-05-29' },
        { status: 'PickupCancelled', description: 'PickupCancelled', at: '2026-05-25' }
      ]
    }
  };
  assert.strictEqual(computeOpsState(order), OPS_STATES.LABEL_READY);
  const view = buildShipmentOpsView(order, {
    fulfillmentPaymentGate: { ok: true, reason: 'paid' }
  });
  assert.strictEqual(view.actionCapabilities.downloadLabel, true);
  assert.strictEqual(view.actionCapabilities.downloadManifest, true);
  assert.strictEqual(view.actionCapabilities.shipNow, false);
  assert.strictEqual(view.opsState, OPS_STATES.LABEL_READY);
  assert.match(String(view.providerStatusRaw || ''), /out for pickup/i);
}

function testAutoCancelMessageClassification() {
  const { detectForwardOrderReset } = require('../services/shiprocketReconcile.service');
  const reset = detectForwardOrderReset({
    statusLabel: 'NEW',
    statusMessage: 'Shipment auto-cancelled due to no pickup done in 10 days',
    texts: ['shipment auto cancelled due to no pickup done in 10 days'],
    awbCode: null,
    hadLocalAwb: true
  });
  assert.strictEqual(reset.resetDetected, true);
}

function testAwbAssignedStaysProcessing() {
  const { mapProviderStatusToOrderStatus } = require('../services/shipmentOps/shiprocketStatusMap');
  assert.strictEqual(mapProviderStatusToOrderStatus('AWB Assigned'), 'processing');
  assert.strictEqual(mapProviderStatusToOrderStatus('Ready To Ship'), 'processing');
  assert.strictEqual(mapProviderStatusToOrderStatus('In Transit'), 'shipped');

  const order = {
    orderStatus: 'processing',
    shipmentInfo: {
      awbCode: '14112362507328',
      shipmentId: '123',
      shiprocketOrderId: '999',
      courier: 'Xpressbees Surface',
      providerStatus: 'AWB Assigned',
      labelUrl: 'https://example.com/label.pdf',
      rawEvents: [{ status: 'PickupCancelled', description: 'PickupCancelled', at: new Date() }]
    }
  };
  assert.strictEqual(computeOpsState(order), OPS_STATES.AWB_ASSIGNED);
  const view = buildShipmentOpsView(order, {
    fulfillmentPaymentGate: { ok: true, reason: 'paid' }
  });
  assert.strictEqual(view.primaryAction, 'schedulePickup');
  assert.strictEqual(view.courierOpsLine1, 'AWB assigned');
}

function testAwbAssignedIgnoresStalePickupDate() {
  const order = {
    orderStatus: 'processing',
    shipmentInfo: {
      awbCode: '14112362507328',
      shipmentId: '123',
      shiprocketOrderId: '999',
      courier: 'Xpressbees Surface',
      pickupDate: '2026-05-18',
      pickupScheduledAt: new Date('2026-05-18'),
      providerStatus: 'AWB Assigned',
      providerSnapshot: { pickupScheduled: false, statusLabel: 'AWB Assigned' },
      labelUrl: 'https://example.com/label.pdf',
      rawEvents: [{ status: 'PickupCancelled', description: 'PickupCancelled', at: new Date() }]
    }
  };
  assert.strictEqual(computeOpsState(order), OPS_STATES.AWB_ASSIGNED);
  const view = buildShipmentOpsView(order, {
    fulfillmentPaymentGate: { ok: true, reason: 'paid' }
  });
  assert.strictEqual(view.primaryAction, 'schedulePickup');
  assert.strictEqual(view.actionCapabilities.schedulePickup, true);
  assert.strictEqual(view.actionCapabilities.downloadLabel, false);
}

function testPickupScheduledWithLabelStillNeedsManifest() {
  const order = {
    orderStatus: 'processing',
    shipmentInfo: {
      awbCode: '14112362507328',
      shipmentId: '123',
      shiprocketOrderId: '999',
      courier: 'Xpressbees Surface',
      pickupDate: '2026-05-30',
      pickupScheduledAt: new Date('2026-05-29'),
      providerStatus: 'Pickup Generated',
      providerSnapshot: { pickupScheduled: true, statusLabel: 'PICKUP SCHEDULED' },
      labelUrl: 'https://example.com/label.pdf',
      fulfillmentLabelAwb: '14112362507328',
      manifestUrl: null
    }
  };
  assert.strictEqual(computeOpsState(order), OPS_STATES.PICKUP_SCHEDULED);
  const view = buildShipmentOpsView(order, {
    fulfillmentPaymentGate: { ok: true, reason: 'paid' }
  });
  assert.strictEqual(view.primaryAction, 'generateManifest');
  assert.strictEqual(view.actionCapabilities.downloadLabel, false);
  assert.strictEqual(view.actionCapabilities.schedulePickup, false);
  assert.match(String(view.courierOpsLine1), /pickup scheduled/i);
}

function testStalePickupScheduledWithoutAwbTriggersReset() {
  const shiprocketInstance = require('../utils/shiprocket');
  const ShiprocketService = shiprocketInstance.constructor;
  const { buildPayloadFromSnapshot } = require('../services/shiprocketReconcile.service');

  const snap = ShiprocketService.extractForwardOrderSnapshot({
    id: 1350319109,
    shipment_id: 1346591722,
    status: 'PICKUP SCHEDULED',
    pickup_scheduled_date: '18-May-2026',
    pickup_status: 'PICKUP SCHEDULED For 18 May 2026',
    shipments: { id: 1346591722, awb: '', status: 'PICKUP SCHEDULED' }
  });
  assert.strictEqual(snap.awbCode, null);
  assert.strictEqual(snap.pickupScheduled, false);
  assert.strictEqual(snap.pickupDate, null);
  assert.strictEqual(snap.resetDetected, true);

  const order = {
    orderStatus: 'processing',
    shipmentInfo: {
      awbCode: 'AWBOLD',
      shiprocketOrderId: '1350319109',
      shipmentId: '1346591722',
      pickupDate: '2026-05-18',
      manifestUrl: 'https://example.com/manifest.pdf',
      providerStatus: 'PICKUP SCHEDULED'
    }
  };
  const built = buildPayloadFromSnapshot(snap, order);
  assert.strictEqual(built.reset, true);
}

function testReadyToShipProcessingAllowsShipNow() {
  const order = {
    orderStatus: 'processing',
    shipmentInfo: {
      shiprocketOrderId: '1350319109',
      shipmentId: '1346591722',
      providerStatus: 'NEW'
    }
  };
  assert.strictEqual(computeOpsState(order), OPS_STATES.READY_TO_SHIP);
  const view = buildShipmentOpsView(order, {
    fulfillmentPaymentGate: { ok: true, reason: 'paid' }
  });
  assert.strictEqual(view.actionCapabilities.shipNow, true);
  assert.strictEqual(view.primaryAction, 'shipNow');
}

function testActiveAwbPickupScheduledDoesNotReset() {
  const shiprocketInstance = require('../utils/shiprocket');
  const ShiprocketService = shiprocketInstance.constructor;
  const { buildPayloadFromSnapshot } = require('../services/shiprocketReconcile.service');

  const snap = ShiprocketService.extractForwardOrderSnapshot({
    id: 1350319109,
    shipment_id: 1346591722,
    status: 'PICKUP SCHEDULED',
    awb: '14112362507328',
    pickup_scheduled_date: '30-May-2026',
    pickup_status: 'PICKUP SCHEDULED For 30 May 2026'
  });
  assert.strictEqual(snap.pickupScheduled, true);
  assert.strictEqual(snap.resetDetected, false);

  const order = {
    orderStatus: 'processing',
    shipmentInfo: {
      awbCode: '14112362507328',
      shiprocketOrderId: '1350319109',
      shipmentId: '1346591722',
      pickupDate: '2026-05-30',
      providerStatus: 'PICKUP SCHEDULED'
    }
  };
  const built = buildPayloadFromSnapshot(snap, order);
  assert.strictEqual(built.reset, false);
}

function testLabelPrimaryWhenManifestReady() {
  const order = {
    orderStatus: 'processing',
    shipmentInfo: {
      awbCode: '14112362507328',
      shipmentId: '1346591722',
      shiprocketOrderId: '1350319109',
      courier: 'Xpressbees Surface',
      pickupDate: '2026-06-02',
      pickupScheduledAt: new Date('2026-06-01'),
      manifestUrl: 'https://example.com/manifest.pdf',
      labelUrl: 'https://example.com/label.pdf',
      fulfillmentManifestAwb: '14112362507328',
      fulfillmentLabelAwb: '14112362507328',
      providerStatus: 'Pickup Generated'
    }
  };
  assert.strictEqual(computeOpsState(order), OPS_STATES.LABEL_READY);
  const view = buildShipmentOpsView(order, {
    fulfillmentPaymentGate: { ok: true, reason: 'paid' }
  });
  assert.strictEqual(view.primaryAction, 'downloadLabel');
  assert.strictEqual(view.actionCapabilities.downloadManifest, true);
  assert.strictEqual(view.actionCapabilities.downloadLabel, true);
}

function testStaleArtifactsInvalidatesState() {
  const order = {
    orderStatus: 'processing',
    shipmentInfo: {
      awbCode: 'AWBNEW',
      shipmentId: '123',
      shiprocketOrderId: '999',
      courier: 'Delhivery Surface',
      pickupDate: '2026-06-02',
      pickupScheduledAt: new Date('2026-06-01'),
      manifestUrl: 'https://example.com/old-manifest.pdf',
      labelUrl: 'https://example.com/old-label.pdf',
      fulfillmentManifestAwb: 'AWBOLD',
      fulfillmentLabelAwb: 'AWBOLD',
      providerStatus: 'Pickup Generated',
      providerSnapshot: { pickupScheduled: true, statusLabel: 'PICKUP SCHEDULED' }
    }
  };
  assert.strictEqual(computeOpsState(order), OPS_STATES.PICKUP_SCHEDULED);
  const view = buildShipmentOpsView(order, {
    fulfillmentPaymentGate: { ok: true, reason: 'paid' }
  });
  assert.strictEqual(view.primaryAction, 'generateManifest');
  assert.strictEqual(view.actionCapabilities.downloadManifest, false);
  assert.strictEqual(view.actionCapabilities.downloadLabel, false);
}

function testLegacyLabelUrlWithoutAwbTagStillAllowsLabelDownload() {
  const order = {
    orderStatus: 'processing',
    shipmentInfo: {
      awbCode: 'AWBNEW',
      shipmentId: '123',
      shiprocketOrderId: '999',
      courier: 'Delhivery Surface',
      pickupDate: '2026-06-02',
      pickupScheduledAt: new Date('2026-06-01'),
      manifestUrl: 'https://example.com/manifest-new.pdf',
      fulfillmentManifestAwb: 'AWBNEW',
      labelUrl: 'https://example.com/old-label.pdf',
      fulfillmentLabelAwb: null,
      providerStatus: 'Out For Pickup'
    }
  };
  assert.strictEqual(computeOpsState(order), OPS_STATES.LABEL_READY);
  const view = buildShipmentOpsView(order, {
    fulfillmentPaymentGate: { ok: true, reason: 'paid' }
  });
  assert.strictEqual(view.actionCapabilities.downloadLabel, true);
  assert.strictEqual(view.actionCapabilities.downloadManifest, true);
}

function testRtoProviderStatusMapping() {
  const { mapProviderStatusToOrderStatus, isRtoProviderStatus } = require('../services/shipmentOps/shiprocketStatusMap');
  assert.strictEqual(isRtoProviderStatus('RTO Delivered'), true);
  assert.strictEqual(isRtoProviderStatus('RTO IN TRANSIT'), true);
  assert.strictEqual(isRtoProviderStatus('RTO Initiated'), true);
  assert.strictEqual(isRtoProviderStatus('Delivered'), false);
  assert.strictEqual(isRtoProviderStatus('Undelivered'), false);
  assert.strictEqual(mapProviderStatusToOrderStatus('RTO Delivered'), 'rto');
  assert.strictEqual(mapProviderStatusToOrderStatus('RTO IN TRANSIT'), 'rto');
  assert.strictEqual(mapProviderStatusToOrderStatus('RTO Initiated'), 'rto');
  assert.strictEqual(mapProviderStatusToOrderStatus('Delivered'), 'delivered');
  assert.strictEqual(mapProviderStatusToOrderStatus('Cancelled'), 'cancelled');
}

function testRtoOpsStateUsesShiprocketLabel() {
  const order = {
    orderStatus: 'rto',
    shipmentInfo: {
      awbCode: '14112365632460',
      courier: 'Xpressbees Surface',
      providerStatus: 'RTO Delivered'
    }
  };
  assert.strictEqual(computeOpsState(order), OPS_STATES.RTO);
  const view = buildShipmentOpsView(order, {
    fulfillmentPaymentGate: { ok: true, reason: 'paid' }
  });
  assert.strictEqual(view.courierOpsLine1, 'RTO Delivered');
  assert.strictEqual(view.opsStateLabel, 'RTO Delivered');
  assert.strictEqual(view.actionCapabilities.shipNow, false);
}

function testLegacyCancelledWithRtoProviderStatus() {
  const order = {
    orderStatus: 'cancelled',
    shipmentInfo: {
      awbCode: '14112365632460',
      providerStatus: 'RTO Delivered'
    }
  };
  assert.strictEqual(computeOpsState(order), OPS_STATES.RTO);
  const view = buildShipmentOpsView(order, {
    fulfillmentPaymentGate: { ok: true, reason: 'paid' }
  });
  assert.strictEqual(view.courierOpsLine1, 'RTO Delivered');
}

function testRtoFulfillmentLabel() {
  const { fulfillmentLabelFromOrderStatus } = require('../constants/adminOrderFulfillmentBuckets');
  assert.strictEqual(fulfillmentLabelFromOrderStatus('rto', 'RTO Delivered'), 'RTO Delivered');
  assert.strictEqual(fulfillmentLabelFromOrderStatus('cancelled', 'RTO Delivered'), 'RTO Delivered');
}

function run() {
  testPickupExceptionState();
  testProviderResetState();
  testProviderResetFromSnapshotWhenStillNew();
  testProviderResetSnapshotIgnoredAfterReship();
  testOutForPickupKeepsLabelAndManifestDownloads();
  testAutoCancelMessageClassification();
  testAwbAssignedStaysProcessing();
  testAwbAssignedIgnoresStalePickupDate();
  testPickupScheduledWithLabelStillNeedsManifest();
  testStalePickupScheduledWithoutAwbTriggersReset();
  testReadyToShipProcessingAllowsShipNow();
  testActiveAwbPickupScheduledDoesNotReset();
  testLabelPrimaryWhenManifestReady();
  testStaleArtifactsInvalidatesState();
  testLegacyLabelUrlWithoutAwbTagStillAllowsLabelDownload();
  testListUiPickupScheduled();
  testAwaitingApproval();
  testRtoProviderStatusMapping();
  testRtoOpsStateUsesShiprocketLabel();
  testLegacyCancelledWithRtoProviderStatus();
  testRtoFulfillmentLabel();
  console.log('All shipment ops tests passed.');
}

run();
