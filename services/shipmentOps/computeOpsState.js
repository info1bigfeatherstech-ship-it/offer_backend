/**
 * Derive canonical shipment ops state from order + shipment fields.
 */

const { OPS_STATES, TERMINAL_ORDER_STATUSES } = require('./constants');
const { CLASSIFICATION, normalizeProviderSignals } = require('./normalizeProviderSignals');
const {
  classifyForwardStatusCode,
  isForwardProgressStatus,
  isProviderStatusInTransit,
  isRtoProviderStatus
} = require('./shiprocketStatusMap');
const { isMoneyCapturedPaymentStatus } = require('../../utils/orderPaymentState');
const { isShipmozoPanelBooked } = require('../shipmozoPanelSync.service');

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
function isShipmozoShipmentInfo(shipmentInfo) {
  const si = shipmentInfo || {};
  return (
    String(si.provider || '').toLowerCase() === 'shipmozo' || Boolean(si.shipmozoOrderId)
  );
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
  const si = shipmentInfo || {};
  if (signalClassification === CLASSIFICATION.AWB_ASSIGNED) {
    // Shipmozo auto-pickup: assign flow persists pickupScheduledAt / pickupDate.
    // Do not treat those as "still need schedule" when manual pickup is not required.
    if (
      si.shipmozoNeedsManualPickup !== true &&
      (si.pickupScheduledAt || si.pickupDate) &&
      String(si.provider || '').toLowerCase() === 'shipmozo'
    ) {
      return true;
    }
    return false;
  }
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
  const si = shipmentInfo || {};
  const currentAwb = String(si.awbCode || si.trackingNumber || '').trim();
  if (currentAwb) {
    if (si.manifestUrl) {
      const manifestAwb = String(si.fulfillmentManifestAwb || '').trim();
      // Only reject manifest when we know it belongs to a different AWB cycle.
      if (manifestAwb && manifestAwb !== currentAwb) return false;
    }
    if (si.labelUrl) {
      const labelAwb = String(si.fulfillmentLabelAwb || '').trim();
      // Legacy/panel-sync: stale label URL without AWB tag must not block manifest/label downloads.
      if (labelAwb && labelAwb !== currentAwb) return false;
    }
  }
  return true;
}

/**
 * Ignore stale resetDetected flags after a successful re-ship cycle.
 * @param {object} shipmentInfo
 */
function isStaleProviderSnapshotReset(shipmentInfo) {
  const si = shipmentInfo || {};
  if (si.providerSnapshot?.resetDetected !== true) return false;
  if (!hasAwb(si)) return false;
  const liveStatus = si.providerStatus || si.providerSnapshot?.statusLabel;
  return isForwardProgressStatus(liveStatus, si.providerSnapshot?.statusCode);
}

/**
 * @param {object} shipmentInfo
 * @returns {string|null}
 */
function resolveSnapshotClassification(shipmentInfo) {
  const si = shipmentInfo || {};
  if (si.providerSnapshot?.resetDetected === true && !isStaleProviderSnapshotReset(si)) {
    return CLASSIFICATION.PROVIDER_RESET;
  }
  if (si.providerSnapshot?.statusCode != null) {
    return classifyForwardStatusCode(si.providerSnapshot.statusCode, si.providerSnapshot.statusLabel);
  }
  if (si.providerSnapshot?.pickupScheduled) {
    return CLASSIFICATION.PICKUP_SCHEDULED;
  }
  return null;
}

/**
 * @param {import('mongoose').Document|object} order
 * @returns {string} OPS_STATES value
 */
function computeOpsState(order) {
  const o = order && typeof order === 'object' ? order : {};
  const orderStatus = String(o.orderStatus || '').toLowerCase();
  const si = o.shipmentInfo && typeof o.shipmentInfo === 'object' ? o.shipmentInfo : {};
  const snapshotClass = resolveSnapshotClassification(si);

  const signals = normalizeProviderSignals({
    providerStatus: si.providerStatus,
    rawEvents: si.rawEvents,
  });

  let effectiveClass =
    snapshotClass === CLASSIFICATION.PROVIDER_RESET || signals.classification === CLASSIFICATION.PROVIDER_RESET
      ? CLASSIFICATION.PROVIDER_RESET
      : signals.classification !== CLASSIFICATION.UNKNOWN
        ? signals.classification
        : snapshotClass || signals.classification;

  if (
    effectiveClass === CLASSIFICATION.PROVIDER_RESET &&
    isStaleProviderSnapshotReset(si)
  ) {
    effectiveClass =
      signals.classification !== CLASSIFICATION.UNKNOWN &&
      signals.classification !== CLASSIFICATION.PROVIDER_RESET
        ? signals.classification
        : CLASSIFICATION.PICKUP_SCHEDULED;
  }

  const providerInTransit = isProviderStatusInTransit(si.providerStatus);
  const shiprocketRto = orderStatus === 'rto' || isRtoProviderStatus(si.providerStatus);

  if (orderStatus === 'cancelled' && !shiprocketRto) return OPS_STATES.CANCELLED;
  // Intermediate Razorpay failures used to leave paid orders stuck as payment_failed.
  if (orderStatus === 'payment_failed') {
    if (isMoneyCapturedPaymentStatus(order.paymentStatus) && Number(order.amountPaidInr || 0) > 0.01) {
      return OPS_STATES.AWAITING_APPROVAL;
    }
    return OPS_STATES.PAYMENT_FAILED;
  }
  if (shiprocketRto) return OPS_STATES.RTO;
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

  if (orderStatus === 'confirmed' && !awb) {
    if (isShipmozoShipmentInfo(si) && isShipmozoPanelBooked(si)) {
      return OPS_STATES.PICKUP_SCHEDULED;
    }
    return OPS_STATES.READY_TO_SHIP;
  }

  if (awb) {
    const pickupBooked = isPickupBooked(si, effectiveClass);

    if (!pickupBooked) {
      return OPS_STATES.AWB_ASSIGNED;
    }

    const hasManifest = artifactsValid && Boolean(si.manifestUrl);
    const isShipmozo =
      String(si.provider || '').toLowerCase() === 'shipmozo' ||
      Boolean(si.shipmozoOrderId);
    // Shipmozo labels are fetched live (not stored as labelUrl). labelDownloaded marks completion.
    const hasLabel =
      artifactsValid &&
      (Boolean(si.labelUrl) || (isShipmozo && Boolean(si.labelDownloaded)));

    // Shipmozo has no Shiprocket-style manifest gate — label alone is LABEL_READY.
    if (isShipmozo) {
      if (hasLabel) return OPS_STATES.LABEL_READY;
      return OPS_STATES.PICKUP_SCHEDULED;
    }

    // Shiprocket: AWB often creates label early — manifest is still the next panel step.
    if (hasManifest && hasLabel) return OPS_STATES.LABEL_READY;
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
  isStaleProviderSnapshotReset,
  resolveSnapshotClassification,
  normalizeProviderSignals,
};
