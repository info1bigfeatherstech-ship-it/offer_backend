/**
 * Merge / retain Shiprocket tracking events without wiping high-value RTO history.
 * Replacing rawEvents with a short recent window caused "RTO Delivered" evidence to vanish
 * when later statuses (e.g. RTO Acknowledged) were synced.
 */

const RTO_DELIVERED_BLOB_RE =
  /rto delivered|return delivered|delivered to seller|delivered to warehouse|rto received at warehouse|rto received|rto complete|returned to seller|shipment rto delivered/i;

const NDR_OR_FAULT_BLOB_RE =
  /ndr|undelivered|not available|refus|customer not|wrong address|consignee|could not deliver|maximum attempt/i;

/**
 * @param {object|null|undefined} ev
 * @returns {string}
 */
function eventFingerprint(ev) {
  const at = String(ev?.at || ev?.date || ev?.datetime || '').trim();
  const status = String(ev?.status || '').trim().toLowerCase();
  const desc = String(ev?.description || '').trim().toLowerCase();
  const reason = String(ev?.reason || ev?.rto_reason || ev?.remarks || '').trim().toLowerCase();
  return `${at}|${status}|${desc}|${reason}`;
}

/**
 * @param {object|null|undefined} ev
 * @returns {string}
 */
function eventBlob(ev) {
  return [
    ev?.status,
    ev?.description,
    ev?.reason,
    ev?.rto_reason,
    ev?.remarks,
    ev?.comment,
    ev?.activity,
    ev?.message,
    ev?.status_code_description,
    ev?.ndr_reason
  ]
    .map((x) => String(x || ''))
    .join(' ');
}

/**
 * @param {object|null|undefined} ev
 */
function isHighValueTrackingEvent(ev) {
  const blob = eventBlob(ev);
  return RTO_DELIVERED_BLOB_RE.test(blob) || NDR_OR_FAULT_BLOB_RE.test(blob);
}

/**
 * @param {object|null|undefined} ev
 * @returns {number}
 */
function eventTimeMs(ev) {
  const t = Date.parse(String(ev?.at || ev?.date || ev?.datetime || ''));
  return Number.isFinite(t) ? t : 0;
}

/**
 * Union of existing + incoming tracking rows; never drop Delivered/NDR rows when truncating.
 *
 * @param {Array<object>|null|undefined} existing
 * @param {Array<object>|null|undefined} incoming
 * @param {number} [max=80]
 * @returns {Array<object>}
 */
function mergeShipmentTrackingEvents(existing, incoming, max = 80) {
  const cap = Math.min(120, Math.max(20, Number(max) || 80));
  const map = new Map();

  for (const ev of [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    if (!ev || typeof ev !== 'object') continue;
    const fp = eventFingerprint(ev);
    if (!map.has(fp)) map.set(fp, ev);
  }

  const all = [...map.values()];
  if (all.length <= cap) return all;

  const high = all.filter(isHighValueTrackingEvent);
  const rest = all.filter((e) => !isHighValueTrackingEvent(e));
  rest.sort((a, b) => eventTimeMs(b) - eventTimeMs(a));

  const room = Math.max(0, cap - high.length);
  const out = [...high, ...rest.slice(0, room)];
  // Prefer chronological-ish order for readability (oldest first when timestamps exist)
  out.sort((a, b) => {
    const ta = eventTimeMs(a);
    const tb = eventTimeMs(b);
    if (ta && tb) return ta - tb;
    return 0;
  });
  return out.slice(0, cap);
}

module.exports = {
  mergeShipmentTrackingEvents,
  isHighValueTrackingEvent,
  RTO_DELIVERED_BLOB_RE,
  NDR_OR_FAULT_BLOB_RE
};
