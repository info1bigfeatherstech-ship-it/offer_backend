/**
 * Shared productCode normalization (e-comm ↔ inventory stock APIs).
 * Keep in sync with inventory software rules:
 * - trim + uppercase
 * - suffix canonicalize: 34354-01 → 34354-1
 * - bare codes (34354) stay as-is — no bare→primary resolution on e-comm
 */

const SUFFIXED_PRODUCT_CODE_REGEX = /^([A-Z0-9]+)-(\d+)$/;

function normalizeProductCode(value) {
  const s = String(value ?? '').trim().toUpperCase();
  if (!s) return '';
  const m = s.match(SUFFIXED_PRODUCT_CODE_REGEX);
  if (m) {
    const baseToken = m[1];
    const seq = Number(m[2]);
    if (!Number.isFinite(seq)) return s;
    return `${baseToken}-${seq}`;
  }
  return s;
}

module.exports = {
  SUFFIXED_PRODUCT_CODE_REGEX,
  normalizeProductCode
};
