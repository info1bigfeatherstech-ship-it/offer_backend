/**
 * Normalize Shiprocket provider status + timeline into operational classifications.
 */

const CLASSIFICATION = Object.freeze({
  PICKUP_EXCEPTION: 'PICKUP_EXCEPTION',
  PROVIDER_RESET: 'PROVIDER_RESET',
  IN_TRANSIT: 'IN_TRANSIT',
  OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
  DELIVERED: 'DELIVERED',
  PICKUP_SCHEDULED: 'PICKUP_SCHEDULED',
  MANIFEST: 'MANIFEST',
  AWB_ASSIGNED: 'AWB_ASSIGNED',
  UNKNOWN: 'UNKNOWN',
});

/**
 * @param {string} text
 */
function normalizeText(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

/**
 * Collect searchable text from provider status and shipment events.
 * @param {{ providerStatus?: string|null, rawEvents?: Array<object>|null }} input
 * @returns {string[]}
 */
function collectSignalTexts(input) {
  const texts = [];
  const push = (value) => {
    const n = normalizeText(value);
    if (n) texts.push(n);
  };

  push(input?.providerStatus);

  const events = Array.isArray(input?.rawEvents) ? input.rawEvents : [];
  for (const event of events) {
    push(event?.status);
    push(event?.description);
    push(event?.message);
  }

  return texts;
}

/**
 * @param {string[]} texts
 */
function classifySignalTexts(texts) {
  const combined = texts.join(' ');

  if (
    /pickup\s*exception|pickup\s*failed|pickup\s*error|pickup\s*not\s*completed|wrong\s*courier/.test(
      combined
    )
  ) {
    return CLASSIFICATION.PICKUP_EXCEPTION;
  }

  if (
    /auto\s*cancel|auto\s*cancelled|shipment\s*auto\s*cancel|pickup\s*cancel|pickupcancelled|pickup\s*cancelled|shipment\s*cancel|order\s*cancel|cancelled\s*by\s*courier|pickup\s*not\s*done|no\s*pickup\s*done\s*in\s*\d+\s*days/.test(
      combined
    )
  ) {
    return CLASSIFICATION.PROVIDER_RESET;
  }

  if (/out\s*for\s*delivery|\bofd\b/.test(combined)) {
    return CLASSIFICATION.OUT_FOR_DELIVERY;
  }

  if (/delivered|delivery\s*completed/.test(combined)) {
    return CLASSIFICATION.DELIVERED;
  }

  if (/in\s*transit|picked\s*up|dispatched|\bshipped\b/.test(combined)) {
    return CLASSIFICATION.IN_TRANSIT;
  }

  if (/pickup\s*scheduled|pickup\s*generated|pickup\s*queue|in\s*pickup\s*queue/.test(combined)) {
    return CLASSIFICATION.PICKUP_SCHEDULED;
  }

  if (/manifest/.test(combined)) {
    return CLASSIFICATION.MANIFEST;
  }

  if (/awb\s*assigned|ready\s*to\s*ship|courier\s*assigned|assigned|booked/.test(combined)) {
    return CLASSIFICATION.AWB_ASSIGNED;
  }

  return CLASSIFICATION.UNKNOWN;
}

/**
 * @param {{ providerStatus?: string|null, rawEvents?: Array<object>|null }} input
 */
function normalizeProviderSignals(input) {
  const providerRaw = input?.providerStatus ? String(input.providerStatus).trim() : '';
  const providerTexts = providerRaw ? [normalizeText(providerRaw)] : [];
  const fromProvider = providerTexts.length ? classifySignalTexts(providerTexts) : CLASSIFICATION.UNKNOWN;

  const allTexts = collectSignalTexts(input || {});
  const fromAll = classifySignalTexts(allTexts);

  let classification = fromAll;
  if (fromProvider !== CLASSIFICATION.UNKNOWN) {
    classification = fromProvider;
  }
  if (
    fromProvider === CLASSIFICATION.AWB_ASSIGNED ||
    fromProvider === CLASSIFICATION.PICKUP_SCHEDULED ||
    fromProvider === CLASSIFICATION.MANIFEST
  ) {
    classification = fromProvider;
  }

  return {
    classification,
    texts: allTexts,
    providerStatusRaw: providerRaw || null,
  };
}

module.exports = {
  CLASSIFICATION,
  normalizeProviderSignals,
  normalizeText,
  collectSignalTexts,
  classifySignalTexts,
};
