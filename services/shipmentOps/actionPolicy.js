/**
 * Action capability matrix per ops state.
 */

const {
  OPS_STATES,
  ACTION_KEYS,
  ACTION_LABELS,
  PRIMARY_ACTION_ORDER,
  IN_TRANSIT_ORDER_STATUSES,
} = require('./constants');
const {
  hasAwb,
  hasShipmentId,
  hasShiprocketOrderId,
  areFulfillmentArtifactsValid,
} = require('./computeOpsState');
const { CLASSIFICATION, normalizeProviderSignals } = require('./normalizeProviderSignals');
const { isRtoProviderStatus } = require('./shiprocketStatusMap');
const { isUnpaidTerminalOrder } = require('../../utils/orderPaymentState');

/**
 * @param {string} orderStatus
 */
function isPostConfirmOrderStatus(orderStatus) {
  const st = String(orderStatus || '').toLowerCase();
  return st && !['pending', 'cancelled', 'payment_failed', 'rto'].includes(st);
}

/**
 * @param {Record<string, boolean>} caps
 */
function resolvePrimaryActionKey(caps) {
  // Shiprocket panel flow: after manifest exists, label is the next primary step.
  if (caps.downloadLabel && caps.downloadManifest) {
    return ACTION_KEYS.downloadLabel;
  }
  for (const key of PRIMARY_ACTION_ORDER) {
    if (caps[key]) return key;
  }
  return ACTION_KEYS.openDetail;
}

/**
 * @param {object} params
 * @param {string} params.opsState
 * @param {object} params.order
 * @param {{ ok: boolean, message?: string, code?: string }} params.fulfillmentPaymentGate
 * @param {boolean} [params.canConfirmForFulfillment]
 */
function buildActionPolicy({ opsState, order, fulfillmentPaymentGate, canConfirmForFulfillment }) {
  const o = order && typeof order === 'object' ? order : {};
  const st = String(o.orderStatus || '').toLowerCase();
  const si = o.shipmentInfo || {};
  const gateOk = fulfillmentPaymentGate?.ok === true;
  const awb = hasAwb(si);
  const shipmentId = hasShipmentId(si);
  const shiprocket = hasShiprocketOrderId(si) || shipmentId || awb;
  const shiprocketRto = st === 'rto' || isRtoProviderStatus(si.providerStatus);
  const terminal = isUnpaidTerminalOrder(o) || shiprocketRto;
  const inTransit = IN_TRANSIT_ORDER_STATUSES.includes(st);
  const signals = normalizeProviderSignals({
    providerStatus: si.providerStatus,
    rawEvents: si.rawEvents,
  });
  const providerSignalsValid =
    signals.classification !== CLASSIFICATION.PICKUP_EXCEPTION &&
    signals.classification !== CLASSIFICATION.PROVIDER_RESET;
  const artifactsValid = providerSignalsValid && areFulfillmentArtifactsValid(si, signals.classification);

  /** @type {Record<string, boolean>} */
  const caps = {
    accept: false,
    reject: false,
    shipNow: false,
    schedulePickup: false,
    generateManifest: false,
    downloadManifest: false,
    downloadLabel: false,
    downloadTaxInvoice: isPostConfirmOrderStatus(st),
    syncShiprocket: false,
    refreshTracking: false,
    retryPickup: false,
    cancelShipment: false,
    openShiprocketSupport: false,
    openShiprocket: false,
    track: false,
    openDetail: true,
  };

  /** @type {Record<string, string>} */
  const blockReasons = {};

  const blockFulfillmentArtifacts = (reason) => {
    blockReasons.generateManifest = reason;
    blockReasons.downloadManifest = reason;
    blockReasons.downloadLabel = reason;
    blockReasons.schedulePickup = reason;
  };

  const enableSupportLink = () => {
    caps.openShiprocketSupport = shiprocket;
    caps.openShiprocket = Boolean(si.shiprocketOrderId);
  };

  switch (opsState) {
    case OPS_STATES.AWAITING_APPROVAL:
      caps.accept = canConfirmForFulfillment === true;
      caps.reject = st === 'pending';
      break;

    case OPS_STATES.READY_TO_SHIP:
      caps.shipNow =
        !awb &&
        gateOk &&
        (st === 'confirmed' || (st === 'processing' && Boolean(si.shiprocketOrderId)));
      caps.syncShiprocket = shiprocket && gateOk;
      if (!gateOk && fulfillmentPaymentGate?.message) {
        blockReasons.shipNow = fulfillmentPaymentGate.message;
      }
      break;

    case OPS_STATES.AWB_ASSIGNED:
      caps.schedulePickup = awb && shipmentId && gateOk && !inTransit && st !== 'delivered' && !terminal;
      caps.syncShiprocket = shiprocket && !terminal;
      caps.refreshTracking = awb;
      caps.openShiprocket = Boolean(si.shiprocketOrderId);
      caps.cancelShipment = shiprocket && gateOk && !terminal;
      break;

    case OPS_STATES.PICKUP_SCHEDULED:
      caps.generateManifest =
        awb && shipmentId && providerSignalsValid && !terminal && !inTransit && st !== 'delivered';
      caps.downloadManifest = awb && shipmentId && artifactsValid && Boolean(si.manifestUrl) && !terminal;
      caps.downloadLabel =
        awb && shipmentId && artifactsValid && Boolean(si.manifestUrl) && !terminal;
      caps.syncShiprocket = shiprocket && !terminal;
      caps.refreshTracking = awb;
      caps.track = awb && (inTransit || st === 'processing' || st === 'delivered');
      caps.openShiprocket = Boolean(si.shiprocketOrderId);
      caps.cancelShipment = shiprocket && gateOk && !terminal && !inTransit;
      break;

    case OPS_STATES.MANIFEST_READY:
      caps.downloadManifest = awb && shipmentId && artifactsValid && Boolean(si.manifestUrl) && !terminal;
      caps.downloadLabel = awb && shipmentId && artifactsValid && !terminal;
      caps.generateManifest = awb && shipmentId && providerSignalsValid && !terminal && !inTransit;
      caps.syncShiprocket = shiprocket && !terminal;
      caps.refreshTracking = awb;
      caps.track = awb;
      caps.openShiprocket = Boolean(si.shiprocketOrderId);
      caps.cancelShipment = shiprocket && gateOk && !terminal && !inTransit;
      break;

    case OPS_STATES.LABEL_READY:
      caps.downloadManifest = awb && shipmentId && artifactsValid && Boolean(si.manifestUrl) && !terminal;
      caps.downloadLabel = awb && shipmentId && artifactsValid && !terminal;
      caps.syncShiprocket = shiprocket && !terminal;
      caps.refreshTracking = awb;
      caps.track = awb;
      caps.openShiprocket = Boolean(si.shiprocketOrderId);
      break;

    case OPS_STATES.PICKUP_EXCEPTION:
      caps.retryPickup = shipmentId && gateOk;
      enableSupportLink();
      caps.syncShiprocket = shiprocket;
      caps.refreshTracking = awb;
      caps.cancelShipment = shiprocket && gateOk;
      caps.track = awb;
      if (!shipmentId) {
        blockReasons.retryPickup = 'No shipment_id on order — refresh Shiprocket sync first.';
      }
      blockFulfillmentArtifacts(
        'Pickup exception on Shiprocket. Retry pickup, open Shiprocket support, or cancel and ship again before manifest/label.'
      );
      break;

    case OPS_STATES.PROVIDER_RESET:
      caps.shipNow = ['confirmed', 'processing'].includes(st) && gateOk;
      enableSupportLink();
      caps.syncShiprocket = shiprocket;
      caps.refreshTracking = awb;
      caps.cancelShipment = shiprocket && gateOk;
      blockFulfillmentArtifacts(
        'Shiprocket reset this shipment. Refresh sync, then use Ship now to re-create the shipment.'
      );
      if (!gateOk && fulfillmentPaymentGate?.message) {
        blockReasons.shipNow = fulfillmentPaymentGate.message;
      }
      break;

    case OPS_STATES.NEEDS_MANUAL_REVIEW:
      caps.retryPickup = shipmentId && awb && gateOk;
      caps.syncShiprocket = shiprocket;
      caps.refreshTracking = awb;
      enableSupportLink();
      caps.track = awb;
      blockFulfillmentArtifacts('Unknown Shiprocket status — sync and review before manifest or label.');
      break;

    case OPS_STATES.IN_TRANSIT:
    case OPS_STATES.OUT_FOR_DELIVERY:
      caps.track = awb;
      caps.refreshTracking = awb;
      caps.syncShiprocket = shiprocket;
      caps.downloadManifest = awb && Boolean(si.manifestUrl);
      caps.downloadLabel = awb && !terminal;
      caps.openShiprocket = Boolean(si.shiprocketOrderId);
      break;

    case OPS_STATES.DELIVERED:
      caps.track = awb;
      caps.refreshTracking = awb;
      caps.downloadManifest = awb && Boolean(si.manifestUrl);
      caps.downloadLabel = awb;
      break;

    case OPS_STATES.CANCELLED:
    case OPS_STATES.PAYMENT_FAILED:
    default:
      break;
  }

  if (terminal && opsState !== OPS_STATES.DELIVERED) {
    caps.shipNow = false;
    caps.schedulePickup = false;
    caps.generateManifest = false;
    caps.downloadManifest = false;
    caps.downloadLabel = false;
    caps.cancelShipment = false;
    caps.retryPickup = false;
  }

  const manifestDownloaded = Boolean(si.manifestDownloaded);
  const labelDownloaded = Boolean(si.labelDownloaded);

  if (caps.downloadManifest && !terminal && !inTransit && (st === 'processing' || st === 'confirmed')) {
    if (!manifestDownloaded) {
      caps.downloadLabel = false;
    }
  }

  const primaryAction = resolvePrimaryActionKey(caps);
  const nextStepMessage = buildNextStepMessage(opsState, blockReasons, primaryAction);

  return {
    actionCapabilities: caps,
    blockReasons,
    primaryAction,
    primaryActionLabel: ACTION_LABELS[primaryAction] || ACTION_LABELS.openDetail,
    nextStepMessage,
    riskFlags: buildRiskFlags(opsState),
  };
}

/**
 * @param {string} opsState
 * @param {Record<string, string>} blockReasons
 * @param {string} primaryAction
 */
function buildNextStepMessage(opsState, blockReasons, primaryAction) {
  switch (opsState) {
    case OPS_STATES.PICKUP_EXCEPTION:
      return (
        blockReasons.retryPickup ||
        'Pickup failed on Shiprocket. Try Retry pickup first. If it persists, open Shiprocket support or cancel and ship again.'
      );
    case OPS_STATES.PROVIDER_RESET:
      return 'Shiprocket reset this shipment (e.g. auto-cancel). Refresh sync, then use Ship now to re-create the shipment.';
    case OPS_STATES.NEEDS_MANUAL_REVIEW:
      return 'Unmapped Shiprocket status. Refresh Shiprocket, review tracking, then proceed.';
    case OPS_STATES.READY_TO_SHIP:
      return primaryAction === ACTION_KEYS.shipNow
        ? 'Assign courier and AWB on Shiprocket (Ship now).'
        : 'Complete payment or approval before shipping.';
    case OPS_STATES.PICKUP_SCHEDULED:
      return 'Pickup booked on Shiprocket. Generate manifest next (same as Shiprocket panel).';
    case OPS_STATES.AWB_ASSIGNED:
      return 'AWB assigned. Schedule pickup on Shiprocket.';
    default:
      return '';
  }
}

/**
 * @param {string} opsState
 */
function buildRiskFlags(opsState) {
  return {
    pickupException: opsState === OPS_STATES.PICKUP_EXCEPTION,
    providerReset: opsState === OPS_STATES.PROVIDER_RESET,
    needsManualReview: opsState === OPS_STATES.NEEDS_MANUAL_REVIEW,
    requiresSupport: opsState === OPS_STATES.PICKUP_EXCEPTION || opsState === OPS_STATES.NEEDS_MANUAL_REVIEW,
  };
}

module.exports = {
  buildActionPolicy,
  resolvePrimaryActionKey,
  isPostConfirmOrderStatus,
  buildNextStepMessage,
  buildRiskFlags,
};
