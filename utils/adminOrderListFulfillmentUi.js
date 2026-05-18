/**
 * Admin order list — courier ops summary + per-row action capabilities (from real order/shipment fields).
 */

const TERMINAL_STATUSES = new Set(['cancelled', 'payment_failed', 'delivered']);
const IN_TRANSIT_STATUSES = new Set(['shipped', 'out_for_delivery']);

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
 * @param {string} awb
 */
function maskAwb(awb) {
  const s = String(awb || '').trim();
  if (s.length <= 8) return s;
  return `…${s.slice(-6)}`;
}

/**
 * @param {object} order — plain order object (may include shipmentInfo)
 */
function buildCourierOpsDisplay(order) {
  const o = order && typeof order === 'object' ? order : {};
  const st = String(o.orderStatus || '').toLowerCase();
  const si = o.shipmentInfo && typeof o.shipmentInfo === 'object' ? o.shipmentInfo : {};
  const hasAwb = Boolean(si.awbCode || si.trackingNumber);
  const pickupDate = si.pickupDate ? String(si.pickupDate).trim() : null;
  const providerStatus = String(si.providerStatus || '').trim();
  const courier = String(si.courier || '').trim();
  const manifestUrl = si.manifestUrl ? String(si.manifestUrl).trim() : '';
  const labelUrl = si.labelUrl ? String(si.labelUrl).trim() : '';
  const awb = String(si.awbCode || si.trackingNumber || '').trim();
  const estimatedDelivery = String(si.estimatedDelivery || '').trim();
  const pickupId = String(si.pickupId || o.pickup_id || '').trim();

  if (st === 'cancelled') {
    return { line1: 'Cancelled', line2: null };
  }
  if (st === 'payment_failed') {
    return { line1: 'Payment failed', line2: null };
  }
  if (st === 'pending') {
    const gate = o.fulfillmentPaymentGate;
    const payLine =
      gate && gate.ok === false
        ? String(gate.message || 'Payment not ready')
        : null;
    return { line1: 'Awaiting approval', line2: payLine };
  }
  if (st === 'delivered') {
    return {
      line1: 'Delivered',
      line2: formatShortDateTime(si.deliveredAt) || formatPickupDateHuman(pickupDate)
    };
  }
  if (IN_TRANSIT_STATUSES.has(st)) {
    const line1 = st === 'out_for_delivery' ? 'Out for delivery' : 'In transit';
    const parts = [];
    if (courier) parts.push(courier);
    if (awb) parts.push(`AWB ${maskAwb(awb)}`);
    if (estimatedDelivery) parts.push(`ETA ${estimatedDelivery}`);
    return { line1, line2: parts.length ? parts.join(' · ') : null };
  }
  if (st === 'confirmed' && !hasAwb) {
    return { line1: 'Ready to ship', line2: 'Assign courier (Ship now)' };
  }

  if (hasAwb) {
    let line1 = providerStatus || 'AWB assigned';
    if (pickupDate || /pickup\s*scheduled/i.test(providerStatus)) {
      line1 = 'Pickup scheduled';
    } else if (/pickup\s*generated/i.test(providerStatus)) {
      line1 = 'Pickup generated';
    } else if (manifestUrl) {
      line1 = 'Manifest ready';
    } else if (labelUrl) {
      line1 = 'Label ready';
    }

    const parts = [];
    if (pickupDate) parts.push(formatPickupDateHuman(pickupDate));
    else if (pickupId) parts.push(pickupId);
    if (courier) parts.push(courier);
    if (!pickupDate && awb) parts.push(`AWB ${maskAwb(awb)}`);
    return { line1, line2: parts.length ? parts.join(' · ') : null };
  }

  if (providerStatus) {
    return { line1: providerStatus, line2: courier || null };
  }
  return { line1: '—', line2: null };
}

/**
 * @param {string} orderStatus
 */
function isPostConfirmOrderStatus(orderStatus) {
  const st = String(orderStatus || '').toLowerCase();
  return st && !['pending', 'cancelled', 'payment_failed'].includes(st);
}

/**
 * @param {object} row — mapped list row fields
 */
function buildRowActionCapabilities(row) {
  const st = String(row.orderStatus || '').toLowerCase();
  const terminal = TERMINAL_STATUSES.has(st) && st !== 'delivered';
  const hasAwb = Boolean(row.hasAwb);
  const hasShipmentId = Boolean(row.hasShipmentId);
  const hasShiprocket =
    Boolean(row.hasShiprocketOrderId) || hasShipmentId || hasAwb;

  return {
    accept: st === 'pending' && row.canConfirmForFulfillment === true,
    reject: st === 'pending',
    shipNow: st === 'confirmed' && !hasAwb,
    schedulePickup:
      hasAwb && !row.pickupScheduled && !terminal && st !== 'delivered' && !IN_TRANSIT_STATUSES.has(st),
    generateManifest:
      hasAwb &&
      hasShipmentId &&
      !row.hasManifest &&
      !terminal &&
      !IN_TRANSIT_STATUSES.has(st) &&
      st !== 'delivered',
    downloadManifest:
      hasAwb && hasShipmentId && Boolean(row.hasManifest) && !terminal,
    downloadLabel: hasAwb && hasShipmentId && !terminal,
    downloadTaxInvoice: isPostConfirmOrderStatus(st),
    syncShiprocket: hasShiprocket && !terminal,
    track:
      hasAwb &&
      (IN_TRANSIT_STATUSES.has(st) || st === 'delivered' || (st === 'processing' && row.pickupScheduled)),
    openDetail: true
  };
}

/** First enabled action for compact primary button. */
const PRIMARY_ACTION_ORDER = [
  'accept',
  'shipNow',
  'schedulePickup',
  'generateManifest',
  'downloadManifest',
  'downloadLabel',
  'track',
  'syncShiprocket',
  'downloadTaxInvoice',
  'openDetail'
];

/**
 * @param {Record<string, boolean>} caps
 */
function resolvePrimaryActionKey(caps) {
  for (const key of PRIMARY_ACTION_ORDER) {
    if (caps[key]) return key;
  }
  return 'openDetail';
}

const ACTION_LABELS = {
  accept: 'Accept',
  reject: 'Reject',
  shipNow: 'Ship now',
  schedulePickup: 'Schedule pickup',
  generateManifest: 'Generate manifest',
  downloadManifest: 'Download manifest',
  downloadLabel: 'Download label',
  downloadTaxInvoice: 'Tax invoice',
  syncShiprocket: 'Refresh Shiprocket',
  track: 'Track',
  openDetail: 'Open order'
};

/**
 * @param {object} order
 */
function buildListRowFulfillmentUi(order) {
  const courierOps = buildCourierOpsDisplay(order);
  const actionCapabilities = buildRowActionCapabilities(order);
  const primaryAction = resolvePrimaryActionKey(actionCapabilities);
  return {
    courierOpsLine1: courierOps.line1,
    courierOpsLine2: courierOps.line2,
    actionCapabilities,
    primaryAction,
    primaryActionLabel: ACTION_LABELS[primaryAction] || 'Open order'
  };
}

module.exports = {
  buildCourierOpsDisplay,
  buildRowActionCapabilities,
  buildListRowFulfillmentUi,
  formatPickupDateHuman,
  isPostConfirmOrderStatus,
  ACTION_LABELS
};
