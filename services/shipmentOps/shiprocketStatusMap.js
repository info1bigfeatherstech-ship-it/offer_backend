/**
 * Map Shiprocket forward-order signals to operational classifications.
 * Status codes are best-effort; regex on status text is the fallback.
 */

const { CLASSIFICATION, classifySignalTexts, normalizeText } = require('./normalizeProviderSignals');

/** Shiprocket status_code values that imply cancellation / reset (forward orders). */
const CANCEL_STATUS_CODES = new Set([5, 8, 16, 45, 46, 47]);

/** Status codes that imply pickup is booked / generated. */
const PICKUP_BOOKED_STATUS_CODES = new Set([4, 12, 13, 14, 15]);

/** Status codes that imply in-transit or later. */
const IN_TRANSIT_STATUS_CODES = new Set([6, 7, 17, 18, 19, 20, 21, 22, 38, 39, 40, 41, 42]);

/**
 * Collect all searchable text from orders/show root + shipment block.
 * @param {object|null} root
 * @param {object|null} shipment
 * @returns {string[]}
 */
function collectForwardOrderTexts(root, shipment) {
  const texts = [];
  const push = (value) => {
    const n = normalizeText(value);
    if (n) texts.push(n);
  };

  if (!root || typeof root !== 'object') return texts;
  const sh = shipment && typeof shipment === 'object' ? shipment : {};

  [
    root.status,
    root.status_message,
    root.shipment_status,
    root.current_status,
    root.sr_status_label,
    root.error,
    root.errors,
    root.message,
    root.comment,
    root.remark,
    root.pickup_status,
    sh.status,
    sh.status_message,
    sh.shipment_status,
    sh.sub_status,
    sh.error,
    sh.message,
    sh.comment,
    sh.remark,
    sh.pickup_status
  ].forEach(push);

  if (Array.isArray(root.errors)) {
    for (const err of root.errors) {
      if (typeof err === 'string') push(err);
      else if (err && typeof err === 'object') {
        push(err.message);
        push(err.error);
      }
    }
  }

  return texts;
}

/**
 * @param {{ statusCode?: number|null, statusLabel?: string|null, statusMessage?: string|null, texts?: string[], awbCode?: string|null, hadLocalAwb?: boolean, hadLocalPickup?: boolean, hadLocalManifestOrLabel?: boolean, apiPickupScheduled?: boolean, apiPickupDate?: string|null }} input
 */
function isForwardProgressStatus(statusLabel, statusCode) {
  const cls = classifyForwardStatusCode(statusCode, statusLabel);
  if (
    cls === CLASSIFICATION.AWB_ASSIGNED ||
    cls === CLASSIFICATION.PICKUP_SCHEDULED ||
    cls === CLASSIFICATION.MANIFEST ||
    cls === CLASSIFICATION.IN_TRANSIT ||
    cls === CLASSIFICATION.OUT_FOR_DELIVERY ||
    cls === CLASSIFICATION.DELIVERED
  ) {
    return true;
  }
  const label = normalizeText(statusLabel);
  return /pickup generated|pickup scheduled|pickup queued|out for pickup|\bofp\b|ready to ship|awb assigned|manifest|in transit|out for delivery|\bdelivered\b|shipped/.test(
    label
  );
}

function isStaleCancelTimelineStatus(value) {
  return /pickupcancelled|pickup cancelled|auto cancel|shipment reset on shiprocket/.test(normalizeText(value));
}

/**
 * Drop prior-cycle cancel rows when Shiprocket already shows forward progress.
 * @param {Array<object>|null|undefined} events
 * @param {string|null|undefined} providerStatus
 * @returns {Array<object>}
 */
function sanitizeTrackingEventsForProvider(events, providerStatus) {
  const list = Array.isArray(events) ? [...events] : [];
  if (list.length === 0) return list;
  if (!isForwardProgressStatus(providerStatus, null)) return list;

  const filtered = list.filter((event) => {
    const status = event?.status || event?.description || '';
    return !isStaleCancelTimelineStatus(status);
  });

  if (filtered.length > 0) return filtered;

  return [
    {
      status: String(providerStatus || 'Shipment update').trim(),
      description: null,
      location: null,
      at: new Date()
    }
  ];
}

function detectForwardOrderReset(input) {
  const statusCode = Number(input.statusCode);
  const label = normalizeText(input.statusLabel);
  const hasAwb = Boolean(input.awbCode && String(input.awbCode).trim());
  const hadLocalForwardCycle = Boolean(
    input.hadLocalAwb || input.hadLocalPickup || input.hadLocalManifestOrLabel
  );

  if (hasAwb && isForwardProgressStatus(input.statusLabel, input.statusCode)) {
    if (!Number.isFinite(statusCode) || !CANCEL_STATUS_CODES.has(statusCode)) {
      return { resetDetected: false, reason: null, classification: null };
    }
  }

  const texts = Array.isArray(input.texts) ? [...input.texts] : [];
  if (input.statusLabel) texts.push(label);
  if (input.statusMessage) texts.push(normalizeText(input.statusMessage));

  const classification = classifySignalTexts(texts);
  if (classification === CLASSIFICATION.PROVIDER_RESET) {
    if (hasAwb && isForwardProgressStatus(input.statusLabel, input.statusCode)) {
      return { resetDetected: false, reason: null, classification: null };
    }
    return {
      resetDetected: true,
      reason: input.statusMessage || input.statusLabel || 'Shipment reset on Shiprocket',
      classification
    };
  }

  if (Number.isFinite(statusCode) && CANCEL_STATUS_CODES.has(statusCode)) {
    return {
      resetDetected: true,
      reason: input.statusMessage || input.statusLabel || 'Cancelled on Shiprocket',
      classification: CLASSIFICATION.PROVIDER_RESET
    };
  }

  const combined = texts.join(' ');

  // Shiprocket invariant: no AWB means no active pickup cycle.
  if (!hasAwb && hadLocalForwardCycle) {
    return {
      resetDetected: true,
      reason:
        input.statusMessage ||
        input.statusLabel ||
        'AWB cleared on Shiprocket — re-ship required',
      classification: CLASSIFICATION.PROVIDER_RESET
    };
  }

  if (
    /^new$/.test(label) &&
    (/auto\s*cancel|pickup\s*not\s*done|no pickup done/.test(combined) || hadLocalForwardCycle)
  ) {
    return {
      resetDetected: true,
      reason: input.statusMessage || combined.slice(0, 120) || 'Order returned to New on Shiprocket',
      classification: CLASSIFICATION.PROVIDER_RESET
    };
  }

  if (input.hadLocalAwb && !input.awbCode && /cancel|auto cancel|pickup cancel/.test(combined)) {
    return {
      resetDetected: true,
      reason: input.statusMessage || 'Shipment cancelled — re-ship required',
      classification: CLASSIFICATION.PROVIDER_RESET
    };
  }

  return { resetDetected: false, reason: null, classification };
}

/**
 * @param {number|null|undefined} statusCode
 * @param {string|null|undefined} statusLabel
 * @returns {string|null} CLASSIFICATION value or null
 */
function classifyForwardStatusCode(statusCode, statusLabel) {
  const code = Number(statusCode);
  if (Number.isFinite(code)) {
    if (CANCEL_STATUS_CODES.has(code)) return CLASSIFICATION.PROVIDER_RESET;
    if (PICKUP_BOOKED_STATUS_CODES.has(code)) return CLASSIFICATION.PICKUP_SCHEDULED;
    if (IN_TRANSIT_STATUS_CODES.has(code)) return CLASSIFICATION.IN_TRANSIT;
    if (code === 6) return CLASSIFICATION.DELIVERED;
  }
  const label = normalizeText(statusLabel);
  if (label) return classifySignalTexts([label]);
  return null;
}

/**
 * True when Shiprocket carrier label indicates RTO (return-to-origin) flow.
 * Uses only patterns present in Shiprocket status text — not generic undelivered/NDR.
 * @param {string|null|undefined} rawStatus
 */
function isRtoProviderStatus(rawStatus) {
  const s = normalizeText(rawStatus);
  if (!s) return false;
  if (/pickup scheduled|pickup generated/.test(s)) return false;
  // Shiprocket + Shipmozo courier labels (Case-1 courier RTO)
  return (
    /\brto\b/.test(s) ||
    /return to origin/.test(s) ||
    /returned to origin/.test(s) ||
    /return to seller/.test(s) ||
    /returned to seller/.test(s) ||
    /\brts\b/.test(s)
  );
}

/**
 * Failed delivery attempt / NDR — still in forward transit (not terminal delivered).
 * Must be checked BEFORE any `/delivered/` substring match ("undelivered" contains "delivered").
 * @param {string|null|undefined} rawStatus
 */
function isNdrOrUndeliveredProviderStatus(rawStatus) {
  const s = normalizeText(rawStatus);
  if (!s) return false;
  if (isRtoProviderStatus(s)) return false;
  return (
    /\bundelivered\b/.test(s) ||
    /\bndr\b/.test(s) ||
    /delivery failed|failed delivery|not delivered|delivery attempt failed/.test(s) ||
    /consignee refused|customer refused|refused by customer|customer not available/.test(s)
  );
}

/**
 * True customer delivery — word-boundary so "undelivered" never matches.
 * @param {string|null|undefined} rawStatus
 */
function isTrueDeliveredProviderStatus(rawStatus) {
  const s = normalizeText(rawStatus);
  if (!s) return false;
  if (isNdrOrUndeliveredProviderStatus(s)) return false;
  if (isRtoProviderStatus(s)) return false;
  return /\bdelivered\b|delivery completed/.test(s);
}

/**
 * Map live Shiprocket provider label → internal orderStatus.
 * Pre-transit (AWB, ready to ship, pickup pending) stays `processing`.
 * Only true movement → `shipped` / later.
 * NDR / Undelivered* → `shipped` (In Transit tab) — never `delivered` / `cancelled`.
 * RTO labels → `rto` (exact Shiprocket text kept in shipmentInfo.providerStatus).
 * @param {string|null|undefined} rawStatus
 * @returns {'processing'|'shipped'|'out_for_delivery'|'delivered'|'cancelled'|'rto'|null}
 */
function mapProviderStatusToOrderStatus(rawStatus) {
  const s = normalizeText(rawStatus);
  if (!s) return null;

  if (['shipment created', 'order created', 'created', 'new'].includes(s)) return null;

  if (isRtoProviderStatus(s)) return 'rto';

  if (/out for delivery|\bofd\b/.test(s)) return 'out_for_delivery';

  // NDR / Undelivered-* BEFORE delivered — "undelivered" contains substring "delivered".
  if (isNdrOrUndeliveredProviderStatus(s)) return 'shipped';

  if (isTrueDeliveredProviderStatus(s)) return 'delivered';

  if (/\bcancel/.test(s) && !/pickup scheduled|pickup generated/.test(s)) {
    return 'cancelled';
  }

  if (/in transit|picked up|dispatched|\bshipped\b/.test(s)) return 'shipped';

  if (
    /awb assigned|ready to ship|pickup scheduled|pickup generated|pickup queue|in pickup queue|out for pickup|\bofp\b|manifest|label|courier assigned|booked/.test(
      s
    )
  ) {
    return 'processing';
  }

  return null;
}

/**
 * True when Shiprocket indicates parcel is moving (not ready-to-ship / AWB-only).
 * @param {string|null|undefined} rawStatus
 */
function isProviderStatusInTransit(rawStatus) {
  const mapped = mapProviderStatusToOrderStatus(rawStatus);
  return mapped === 'shipped' || mapped === 'out_for_delivery' || mapped === 'delivered';
}

module.exports = {
  CANCEL_STATUS_CODES,
  PICKUP_BOOKED_STATUS_CODES,
  IN_TRANSIT_STATUS_CODES,
  collectForwardOrderTexts,
  detectForwardOrderReset,
  classifyForwardStatusCode,
  isForwardProgressStatus,
  isStaleCancelTimelineStatus,
  sanitizeTrackingEventsForProvider,
  isRtoProviderStatus,
  isNdrOrUndeliveredProviderStatus,
  isTrueDeliveredProviderStatus,
  mapProviderStatusToOrderStatus,
  isProviderStatusInTransit
};
