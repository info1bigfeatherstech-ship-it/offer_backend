/**
 * Courier ops display lines + external Shiprocket links.
 */

const { OPS_STATES } = require('./constants');
const { hasAwb } = require('./computeOpsState');

/**
 * @param {Date|string|null|undefined} dt
 */
function formatShortDateTime(dt) {
  if (!dt) return null;
  const d = dt instanceof Date ? dt : new Date(dt);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-IN', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).format(d);
}

/**
 * @param {string} ymd
 */
function formatPickupDateHuman(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || '').trim());
  if (!m) return String(ymd || '').trim() || null;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const mo = months[Number(m[2]) - 1];
  if (!mo) return ymd;
  return `${Number(m[3])} ${mo} ${m[1]}`;
}

/**
 * @param {string} awb
 */
function maskAwb(awb) {
  const s = String(awb || '').trim();
  if (s.length <= 8) return s;
  return `…${s.slice(-6)}`;
}

/**
 * @param {{ opsState: string, order: object }} params
 */
function buildCourierOpsDisplay({ opsState, order }) {
  const o = order && typeof order === 'object' ? order : {};
  const st = String(o.orderStatus || '').toLowerCase();
  const si = o.shipmentInfo || {};
  const providerStatus = String(si.providerStatus || '').trim();
  const courier = String(si.courier || '').trim();
  const pickupDate = si.pickupDate ? String(si.pickupDate).trim() : null;
  const awb = String(si.awbCode || si.trackingNumber || '').trim();

  if (st === 'cancelled') return { line1: 'Cancelled', line2: null };
  if (st === 'payment_failed') return { line1: 'Payment failed', line2: null };

  switch (opsState) {
    case OPS_STATES.AWAITING_APPROVAL: {
      const gate = o.fulfillmentPaymentGate;
      const payLine =
        gate && gate.ok === false ? String(gate.message || 'Payment not ready') : null;
      return { line1: 'Awaiting approval', line2: payLine };
    }
    case OPS_STATES.READY_TO_SHIP:
      return { line1: 'Ready to ship', line2: 'Assign courier (Ship now)' };
    case OPS_STATES.PICKUP_EXCEPTION: {
      const parts = [];
      if (providerStatus) parts.push(providerStatus);
      if (courier) parts.push(courier);
      return {
        line1: 'Pickup exception — action required',
        line2: parts.length ? parts.join(' · ') : 'Open Shiprocket support if retry fails',
      };
    }
    case OPS_STATES.PROVIDER_RESET:
      return {
        line1: 'Shipment reset on Shiprocket',
        line2: si.providerSnapshot?.resetReason || providerStatus || 'Refresh sync, then Ship now',
      };
    case OPS_STATES.NEEDS_MANUAL_REVIEW:
      return {
        line1: 'Review Shiprocket status',
        line2: providerStatus || 'Sync required',
      };
    case OPS_STATES.PICKUP_SCHEDULED: {
      const parts = [];
      if (pickupDate) parts.push(formatPickupDateHuman(pickupDate));
      if (courier) parts.push(courier);
      if (!pickupDate && awb) parts.push(`AWB ${maskAwb(awb)}`);
      return { line1: 'Pickup scheduled', line2: parts.length ? parts.join(' · ') : null };
    }
    case OPS_STATES.MANIFEST_READY:
      return { line1: 'Manifest ready', line2: courier || null };
    case OPS_STATES.LABEL_READY:
      return { line1: 'Label ready', line2: courier || null };
    case OPS_STATES.AWB_ASSIGNED: {
      const parts = [];
      if (courier) parts.push(courier);
      if (awb) parts.push(`AWB ${maskAwb(awb)}`);
      const line1 = /ready to ship/i.test(providerStatus) ? 'Ready to ship' : 'AWB assigned';
      return { line1, line2: parts.length ? parts.join(' · ') : null };
    }
    case OPS_STATES.IN_TRANSIT:
      return {
        line1: 'In transit',
        line2: [courier, awb ? `AWB ${maskAwb(awb)}` : ''].filter(Boolean).join(' · ') || null,
      };
    case OPS_STATES.OUT_FOR_DELIVERY:
      return { line1: 'Out for delivery', line2: courier || null };
    case OPS_STATES.DELIVERED: {
      const deliveredAt = si.deliveredAt ? formatShortDateTime(si.deliveredAt) : null;
      return {
        line1: 'Delivered',
        line2: deliveredAt || (pickupDate ? formatPickupDateHuman(pickupDate) : null)
      };
    }
    default:
      if (providerStatus) return { line1: providerStatus, line2: courier || null };
      if (hasAwb(si)) return { line1: 'AWB assigned', line2: courier || null };
      return { line1: '—', line2: null };
  }
}

/**
 * Build Shiprocket panel deep links for admin actions.
 * @param {object} order
 */
function buildExternalLinks(order) {
  const si = order?.shipmentInfo || {};
  const shiprocketOrderId = si.shiprocketOrderId ? String(si.shiprocketOrderId).trim() : '';
  const awb = String(si.awbCode || si.trackingNumber || '').trim();
  const basePanel =
    String(process.env.SHIPROCKET_SELLER_PANEL_BASE_URL || 'https://app.shiprocket.in').replace(/\/$/, '');

  const orderUrl = shiprocketOrderId
    ? `${basePanel}/seller/orders/details/${encodeURIComponent(shiprocketOrderId)}`
    : `${basePanel}/seller/orders`;

  const ticketUrl = shiprocketOrderId
    ? `${orderUrl}?support=1`
    : `${basePanel}/seller/support`;

  const trackingUrl = awb
    ? `${basePanel}/seller/tracking/${encodeURIComponent(awb)}`
    : orderUrl;

  return {
    shiprocketOrderUrl: orderUrl,
    shiprocketSupportUrl: ticketUrl,
    /** @deprecated use shiprocketSupportUrl */
    createTicketUrl: ticketUrl,
    trackingUrl,
  };
}

/**
 * @param {object} order
 */
function computeSyncHealth(order) {
  const si = order?.shipmentInfo || {};
  const lastSync = si.lastSyncAt ? new Date(si.lastSyncAt).getTime() : NaN;
  if (!Number.isFinite(lastSync)) return 'unknown';
  const ageMs = Date.now() - lastSync;
  if (ageMs > 2 * 60 * 60 * 1000) return 'stale';
  if (si.lastError) return 'error';
  return 'ok';
}

module.exports = {
  buildCourierOpsDisplay,
  buildExternalLinks,
  computeSyncHealth,
  formatPickupDateHuman,
  maskAwb,
};
