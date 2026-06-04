/**
 * Customer-facing tracking labels only (storefront / user orders).
 * Does not alter Shiprocket sync, reconcile, or admin timelines.
 */

/** Xpressbees / Shiprocket scan codes → plain English */
const CARRIER_CODE_LABELS = Object.freeze({
  DRC: 'Shipment received by courier',
  OFP: 'Out for pickup',
  PUD: 'Picked up',
  IT: 'In transit',
  OFD: 'Out for delivery',
  DLVD: 'Delivered',
  DEL: 'Delivered',
  DELIVERED: 'Delivered',
  SHIPPED: 'Shipped',
  INT: 'In transit',
  INTRANSIT: 'In transit',
  'IN TRANSIT': 'In transit',
  RAD: 'Reached destination hub',
  RTO: 'Return to origin',
  RTD: 'Return delivered',
  NDR: 'Delivery attempt — action needed',
  UNDELIVERED: 'Delivery attempted',
  PICKED_UP: 'Picked up',
  PICKEDUP: 'Picked up',
  MANIFESTED: 'Shipment manifested',
  REACHED: 'Reached local facility',
});

const ORDER_STATUS_HEADLINES = Object.freeze({
  pending: 'We received your order',
  confirmed: 'Preparing your shipment',
  processing: 'Your order is on the way',
  shipped: 'Your order has been shipped',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  return_requested: 'Return requested',
  cancelled: 'Order cancelled',
  payment_failed: 'Payment could not be completed',
});

function normalizeText(value) {
  return String(value || '')
    .trim()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function isRawCarrierCode(value) {
  const t = normalizeText(value).toUpperCase();
  if (!t) return true;
  if (/^\d+$/.test(t)) return true;
  if (/^[A-Z]{2,6}$/.test(t)) return true;
  return false;
}

function titleCasePhrase(text) {
  return normalizeText(text)
    .split(' ')
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : ''))
    .join(' ');
}

/**
 * Pick a human-readable label for one carrier scan event.
 * @param {{ status?: string|null, description?: string|null, code?: string|null, location?: string|null, at?: Date|string|null }} event
 */
function resolveCourierEventLabel(event) {
  const description = normalizeText(event?.description);
  const status = normalizeText(event?.status);
  const code = normalizeText(event?.code).toUpperCase();

  if (description && !isRawCarrierCode(description) && description.toLowerCase() !== status.toLowerCase()) {
    return titleCasePhrase(description);
  }

  const statusKey = status.toUpperCase();
  if (CARRIER_CODE_LABELS[statusKey]) return CARRIER_CODE_LABELS[statusKey];
  if (code && CARRIER_CODE_LABELS[code]) return CARRIER_CODE_LABELS[code];

  if (status && !isRawCarrierCode(status)) {
    return titleCasePhrase(status);
  }

  if (description && !isRawCarrierCode(description)) {
    return titleCasePhrase(description);
  }

  return 'Shipment update';
}

function normalizeEventTimestamp(value) {
  if (!value) return null;
  const dt = value instanceof Date ? value : new Date(value);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/**
 * Map live carrier events for Layer B (optional courier detail).
 * @param {Array<object>|null|undefined} events
 * @returns {Array<{ status: string, completed: boolean, timestamp: Date|null, location: string|null, description: string|null }>}
 */
function buildCustomerCourierTimeline(events) {
  if (!Array.isArray(events) || events.length === 0) return [];

  const mapped = events
    .map((event) => {
      const timestamp = normalizeEventTimestamp(event?.at);
      const label = resolveCourierEventLabel(event);
      const location = normalizeText(event?.location) || null;
      return {
        status: label,
        completed: true,
        timestamp,
        location,
        description: location ? null : normalizeText(event?.description) || null,
        _sort: timestamp ? timestamp.getTime() : 0,
        _day: timestamp ? timestamp.toDateString() : '',
      };
    })
    .filter((row) => row.timestamp)
    .sort((a, b) => a._sort - b._sort);

  const deduped = [];
  for (const row of mapped) {
    const key = `${row.status.toLowerCase()}|${row._day}`;
    const prev = deduped[deduped.length - 1];
    if (prev && prev._key === key) {
      prev.timestamp = row.timestamp;
      prev._sort = row._sort;
      if (row.location) prev.location = row.location;
    } else {
      deduped.push({
        status: row.status,
        completed: true,
        timestamp: row.timestamp,
        location: row.location,
        description: row.description,
        _key: key,
        _sort: row._sort,
      });
    }
  }

  return deduped.map(({ _key, _sort, ...rest }) => rest);
}

/**
 * Short headline for the tracking panel (Layer A context).
 * @param {object} orderDoc
 * @param {string|null|undefined} providerStatus
 */
function getCustomerTrackingSummary(orderDoc, providerStatus) {
  const orderStatus = String(orderDoc?.orderStatus || 'pending').toLowerCase();
  let headline = ORDER_STATUS_HEADLINES[orderStatus] || 'Order update';

  const provider = normalizeText(providerStatus);
  if (provider) {
    const p = provider.toLowerCase();
    if (/delivered/.test(p)) headline = ORDER_STATUS_HEADLINES.delivered;
    else if (/out for delivery|\bofd\b/.test(p)) headline = ORDER_STATUS_HEADLINES.out_for_delivery;
    else if (/in transit|\bit\b|shipped|manifest/.test(p)) headline = ORDER_STATUS_HEADLINES.shipped;
    else if (/out for pickup|\bofp\b|picked up|\bpud\b/.test(p)) headline = 'Courier is collecting your package';
    else if (!isRawCarrierCode(provider)) headline = titleCasePhrase(provider);
  }

  return {
    headline,
    orderStatus,
  };
}

/**
 * @param {{ orderDoc: object, liveEvents?: Array<object>|null, hasAwb?: boolean }} input
 */
function buildCustomerTrackingExtras({ orderDoc, liveEvents, hasAwb }) {
  const providerStatus = orderDoc?.shipmentInfo?.providerStatus || null;
  const summary = getCustomerTrackingSummary(orderDoc, providerStatus);
  const courierTimeline =
    hasAwb && Array.isArray(liveEvents) && liveEvents.length > 0
      ? buildCustomerCourierTimeline(liveEvents)
      : [];

  return {
    statusSummary: summary,
    courierTimeline,
  };
}

module.exports = {
  CARRIER_CODE_LABELS,
  resolveCourierEventLabel,
  buildCustomerCourierTimeline,
  getCustomerTrackingSummary,
  buildCustomerTrackingExtras,
};
