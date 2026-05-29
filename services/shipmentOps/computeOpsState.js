/**
 * Derive canonical shipment ops state from order + shipment fields.
 */

const { OPS_STATES, TERMINAL_ORDER_STATUSES } = require('./constants');
const { CLASSIFICATION, normalizeProviderSignals } = require('./normalizeProviderSignals');
const {
  classifyForwardStatusCode,
  isProviderStatusInTransit
} = require('./shiprocketStatusMap');

/**
 * @param {object|null|undefined} shipmentInfo
 */
function hasAwb(shipmentInfo) {
  const si = shipmentInfo || {};
  return Boolean(si.awbCode || si.trackingNumber);
}

/**
 * @param {object|null|undefined} shipmentInfo
 */
function hasShipmentId(shipmentInfo) {
  return Boolean(shipmentInfo?.shipmentId);
}

/**
 * @param {object|null|undefined} shipmentInfo
 */
function hasShiprocketOrderId(shipmentInfo) {
  return Boolean(shipmentInfo?.shiprocketOrderId);
}

/**
 * Pickup is only "active" when provider has not reported exception/reset.
 * @param {object} shipmentInfo
 * @param {string} signalClassification
 */
function isPickupBooked(shipmentInfo, signalClassification) {
  if (
    signalClassification === CLASSIFICATION.PICKUP_EXCEPTION ||
    signalClassification === CLASSIFICATION.PROVIDER_RESET
  ) {
    return false;
  }
  if (signalClassification === CLASSIFICATION.AWB_ASSIGNED) {
    return false;
  }
  const si = shipmentInfo || {};
  const snap = si.providerSnapshot;
  if (snap && snap.pickupScheduled === false) {
    return false;
  }
  if (signalClassification === CLASSIFICATION.PICKUP_SCHEDULED || signalClassification === CLASSIFICATION.MANIFEST) {
    return true;
  }
  if (si.pickupDate || si.pickupScheduledAt) return true;
  return false;
}

/**
 * Manifest/label artifacts are invalid when provider reset or pickup exception is active.
 */
function areFulfillmentArtifactsValid(shipmentInfo, signalClassification) {
  if (
    signalClassification === CLASSIFICATION.PICKUP_EXCEPTION ||
    signalClassification === CLASSIFICATION.PROVIDER_RESET
  ) {
    return false;
  }
  return true;
}

/**
 * @param {import('mongoose').Document|object} order
 * @returns {string} OPS_STATES value
 */
function computeOpsState(order) {
  const o = order && typeof order === 'object' ? order : {};
  const orderStatus = String(o.orderStatus || '').toLowerCase();
  const si = o.shipmentInfo && typeof o.shipmentInfo === 'object' ? o.shipmentInfo : {};
  const snapshotClass =
    si.providerSnapshot?.resetDetected === true
      ? CLASSIFICATION.PROVIDER_RESET
      : si.providerSnapshot?.statusCode != null
        ? classifyForwardStatusCode(si.providerSnapshot.statusCode, si.providerSnapshot.statusLabel)
        : si.providerSnapshot?.pickupScheduled
          ? CLASSIFICATION.PICKUP_SCHEDULED
          : null;

  const signals = normalizeProviderSignals({
    providerStatus: si.providerStatus,
    rawEvents: si.rawEvents,
  });

  const effectiveClass =
    snapshotClass === CLASSIFICATION.PROVIDER_RESET || signals.classification === CLASSIFICATION.PROVIDER_RESET
      ? CLASSIFICATION.PROVIDER_RESET
      : signals.classification !== CLASSIFICATION.UNKNOWN
        ? signals.classification
        : snapshotClass || signals.classification;

  const providerInTransit = isProviderStatusInTransit(si.providerStatus);

  if (orderStatus === 'cancelled') return OPS_STATES.CANCELLED;
  if (orderStatus === 'payment_failed') return OPS_STATES.PAYMENT_FAILED;
  if (orderStatus === 'delivered' || effectiveClass === CLASSIFICATION.DELIVERED) {
    return OPS_STATES.DELIVERED;
  }
  if (orderStatus === 'out_for_delivery' || effectiveClass === CLASSIFICATION.OUT_FOR_DELIVERY) {
    return OPS_STATES.OUT_FOR_DELIVERY;
  }
  if (
    (orderStatus === 'shipped' && providerInTransit) ||
    effectiveClass === CLASSIFICATION.IN_TRANSIT
  ) {
    return OPS_STATES.IN_TRANSIT;
  }

  if (effectiveClass === CLASSIFICATION.PICKUP_EXCEPTION) {
    return OPS_STATES.PICKUP_EXCEPTION;
  }
  if (effectiveClass === CLASSIFICATION.PROVIDER_RESET) {
    return OPS_STATES.PROVIDER_RESET;
  }

  if (orderStatus === 'pending') return OPS_STATES.AWAITING_APPROVAL;

  const awb = hasAwb(si);
  const artifactsValid = areFulfillmentArtifactsValid(si, effectiveClass);

  if (orderStatus === 'confirmed' && !awb) return OPS_STATES.READY_TO_SHIP;

  if (awb) {
    const pickupBooked = isPickupBooked(si, effectiveClass);

    if (!pickupBooked) {
      return OPS_STATES.AWB_ASSIGNED;
    }

    const hasManifest = artifactsValid && Boolean(si.manifestUrl);
    const hasLabel = artifactsValid && Boolean(si.labelUrl);

    if (hasLabel) return OPS_STATES.LABEL_READY;
    if (hasManifest) return OPS_STATES.MANIFEST_READY;
    return OPS_STATES.PICKUP_SCHEDULED;
  }

  if (orderStatus === 'processing') return OPS_STATES.READY_TO_SHIP;

  if (
    effectiveClass === CLASSIFICATION.UNKNOWN &&
    (awb || si.providerStatus || (Array.isArray(si.rawEvents) && si.rawEvents.length > 0))
  ) {
    return OPS_STATES.NEEDS_MANUAL_REVIEW;
  }

  if (TERMINAL_ORDER_STATUSES.includes(orderStatus)) {
    return OPS_STATES.NONE;
  }

  return OPS_STATES.NONE;
}

module.exports = {
  computeOpsState,
  hasAwb,
  hasShipmentId,
  hasShiprocketOrderId,
  isPickupBooked,
  areFulfillmentArtifactsValid,
  normalizeProviderSignals,
};
