/**
 * Carrier scan timestamps — Shiprocket often uses ISO `at`;
 * Shipmozo uses `date: "YYYY-MM-DD HH:mm:ss"` (no separate reason field).
 * Keep resolution centralized so track / merge / timeline / admin UI stay aligned.
 */

function resolveShipmentEventTimeRaw(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const raw =
    ev.at ??
    ev.timestamp ??
    ev.time ??
    ev.date ??
    ev.datetime ??
    ev.status_time ??
    null;
  if (raw == null || raw === '') return null;
  return raw;
}

/**
 * @param {unknown} value
 * @returns {Date|null}
 */
function parseShipmentEventDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const s = String(value).trim();
  if (!s) return null;

  // Shipmozo / many courier APIs: "2026-09-12 10:59:12"
  let normalized = s;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?/.test(s)) {
    normalized = s.replace(' ', 'T');
  }

  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * @param {object|null|undefined} ev
 * @returns {Date|null}
 */
function resolveShipmentEventAt(ev) {
  return parseShipmentEventDate(resolveShipmentEventTimeRaw(ev));
}

module.exports = {
  resolveShipmentEventTimeRaw,
  parseShipmentEventDate,
  resolveShipmentEventAt
};
