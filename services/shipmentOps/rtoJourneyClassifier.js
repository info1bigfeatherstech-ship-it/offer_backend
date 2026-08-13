/**
 * Courier RTO journey vs customer delivery — single source of truth.
 *
 * Production rules (sticky by default):
 * - "RTO Delivered" / RTS / return-to-seller is NEVER customer delivery.
 * - Reverse-leg "Delivered" (no RTO word) after RTO evidence stays in RTO.
 * - Demote rto → delivered ONLY with positive proof: current true customer
 *   Delivered + tracking history present + zero RTO evidence in status/events/returnInfo.
 * - Missing timeline → do not demote (ambiguous). Display as RTO Delivered.
 */

const {
  isRtoProviderStatus,
  isTrueDeliveredProviderStatus
} = require('./shiprocketStatusMap');

const RTO_WORKFLOW_TERMINAL = new Set([
  'refunded',
  'refund_failed',
  'refund_rejected',
  'closed',
  'resolved'
]);

const EVENT_TEXT_KEYS = [
  'status',
  'current_status',
  'sr_status',
  'sr-status',
  'code',
  'activity',
  'message',
  'description',
  'reason',
  'rto_reason',
  'remarks',
  'comment',
  'status_code',
  'status_code_description',
  'ndr_reason'
];

function safeText(value) {
  try {
    if (value == null) return '';
    const s = String(value).trim();
    return s;
  } catch {
    return '';
  }
}

function pushText(out, value) {
  const s = safeText(value);
  if (s) out.push(s);
}

/**
 * @param {object|null|undefined} ev
 * @returns {string[]}
 */
function collectEventTexts(ev) {
  const texts = [];
  if (!ev || typeof ev !== 'object') return texts;
  try {
    for (const key of EVENT_TEXT_KEYS) {
      pushText(texts, ev[key]);
    }
    const raw = ev.raw && typeof ev.raw === 'object' ? ev.raw : null;
    if (raw) {
      pushText(texts, raw.sr_status_label);
      pushText(texts, raw.sr_status);
      pushText(texts, raw.status);
      pushText(texts, raw.status_code);
      pushText(texts, raw.activity);
      pushText(texts, raw.message);
    }
  } catch {
    /* ignore malformed event */
  }
  return texts;
}

function isWarehouseDeliveredText(text) {
  try {
    const { isRtoDeliveredToWarehouse } = require('../rtoRefund.service');
    return isRtoDeliveredToWarehouse(text) === true;
  } catch {
    const raw = safeText(text);
    if (!raw) return false;
    return /rto delivered|return delivered|delivered to seller|delivered to warehouse|rto received|rto complete|returned to seller|shipment rto delivered|rts delivered|\brts[\s_-]?d\b/i.test(
      raw
    );
  }
}

function isRtoishText(text) {
  const raw = safeText(text);
  if (!raw) return false;
  try {
    return isRtoProviderStatus(raw) === true || isWarehouseDeliveredText(raw);
  } catch {
    return false;
  }
}

/**
 * Courier-RTO evidence excluding the latched orderStatus itself.
 * @param {import('mongoose').Document|object|null|undefined} order
 */
function hasCourierRtoEvidence(order) {
  try {
    if (!order || typeof order !== 'object') return false;

    const si = order.shipmentInfo && typeof order.shipmentInfo === 'object' ? order.shipmentInfo : {};
    const ri = order.returnInfo && typeof order.returnInfo === 'object' ? order.returnInfo : {};

    if (isRtoishText(si.providerStatus)) return true;
    if (isRtoishText(si.providerSnapshot?.statusLabel)) return true;
    if (ri.rtoWarehouseDeliveredAt) return true;
    if (safeText(ri.rtoShiprocketReason)) return true;
    if (ri.rtoRefundedAt || ri.rtoRejectedAt || ri.rtoResolvedAt || safeText(ri.rtoRefundId)) return true;

    const rtoStatus = safeText(ri.rtoStatus).toLowerCase();
    if (RTO_WORKFLOW_TERMINAL.has(rtoStatus)) return true;

    if (Array.isArray(ri.rtoHistory) && ri.rtoHistory.length > 0) return true;

    const events = Array.isArray(si.rawEvents) ? si.rawEvents : [];
    for (const ev of events) {
      for (const t of collectEventTexts(ev)) {
        if (isRtoishText(t)) return true;
      }
    }

    return false;
  } catch {
    // Fail sticky: treat as RTO evidence so we never demote on classifier errors.
    return true;
  }
}

function trackingHistoryLength(order) {
  try {
    const events = order?.shipmentInfo?.rawEvents;
    return Array.isArray(events) ? events.length : 0;
  } catch {
    return 0;
  }
}

/**
 * True only when it is safe to treat a latched `orderStatus=rto` as customer delivered.
 * Empty/missing timeline is NOT enough — stay in RTO.
 *
 * @param {import('mongoose').Document|object|null|undefined} order
 */
function canClearFalseRtoLatch(order) {
  try {
    if (!order || typeof order !== 'object') return false;
    const st = safeText(order.orderStatus).toLowerCase();
    if (st !== 'rto') return false;

    const providerStatus = order.shipmentInfo?.providerStatus;
    if (!isTrueDeliveredProviderStatus(providerStatus)) return false;
    if (isRtoProviderStatus(providerStatus)) return false;
    if (isWarehouseDeliveredText(providerStatus)) return false;

    if (hasCourierRtoEvidence(order)) return false;
    if (trackingHistoryLength(order) < 1) return false;

    return true;
  } catch {
    return false;
  }
}

/**
 * Admin STATUS / courier-ops label while the order is in the RTO journey.
 * Never surfaces a bare "Delivered" (that is warehouse reverse-leg or a false latch).
 *
 * @param {string|null|undefined} providerStatus
 * @param {import('mongoose').Document|object|null|undefined} [order]
 */
function resolveRtoDisplayLabel(providerStatus, order) {
  try {
    const ps = safeText(providerStatus);
    if (isRtoProviderStatus(ps)) return ps || 'RTO';
    if (isWarehouseDeliveredText(ps)) return ps || 'RTO Delivered';
    if (isTrueDeliveredProviderStatus(ps)) return 'RTO Delivered';
    if (order && hasCourierRtoEvidence(order) && isTrueDeliveredProviderStatus(ps)) {
      return 'RTO Delivered';
    }
    return ps || 'RTO';
  } catch {
    return safeText(providerStatus) || 'RTO';
  }
}

/**
 * @param {import('mongoose').Document|object|null|undefined} order
 * @returns {{ kind: 'rto'|'customer_delivered'|'other', displayLabel: string|null, canDemoteToDelivered: boolean }}
 */
function classifyRtoJourney(order) {
  try {
    const providerStatus = order?.shipmentInfo?.providerStatus;
    const orderStatus = safeText(order?.orderStatus).toLowerCase();
    const rtoEvidence = hasCourierRtoEvidence(order);
    const latchedRto = orderStatus === 'rto';

    if (canClearFalseRtoLatch(order)) {
      return {
        kind: 'customer_delivered',
        displayLabel: safeText(providerStatus) || 'Delivered',
        canDemoteToDelivered: true
      };
    }

    if (latchedRto || rtoEvidence || isRtoProviderStatus(providerStatus)) {
      return {
        kind: 'rto',
        displayLabel: resolveRtoDisplayLabel(providerStatus, order),
        canDemoteToDelivered: false
      };
    }

    if (isTrueDeliveredProviderStatus(providerStatus)) {
      return {
        kind: 'customer_delivered',
        displayLabel: safeText(providerStatus) || 'Delivered',
        canDemoteToDelivered: false
      };
    }

    return {
      kind: 'other',
      displayLabel: safeText(providerStatus) || null,
      canDemoteToDelivered: false
    };
  } catch {
    return {
      kind: 'rto',
      displayLabel: 'RTO',
      canDemoteToDelivered: false
    };
  }
}

module.exports = {
  hasCourierRtoEvidence,
  canClearFalseRtoLatch,
  resolveRtoDisplayLabel,
  classifyRtoJourney
};
