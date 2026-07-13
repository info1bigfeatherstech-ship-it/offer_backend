/**
 * Pure helpers for Shiprocket / local address intelligence (no Shiprocket client import).
 */

const CATEGORY_LABELS = Object.freeze({
  valid: 'Valid Address',
  ambiguous: 'Ambiguous Address',
  junk: 'Junk Address',
  needs_review: 'Needs Review'
});

/**
 * Normalize Shiprocket address_score (0–1 or 0–100) → 0–100 integer percent.
 * @param {unknown} raw
 * @returns {number|null}
 */
function normalizeScorePercent(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n <= 1) return Math.round(n * 100);
  if (n <= 100) return Math.round(n);
  return 100;
}

/**
 * @param {string|null|undefined} raw
 * @param {number|null} scorePercent
 */
function normalizeCategory(raw, scorePercent) {
  const s = String(raw || '')
    .trim()
    .toLowerCase();
  if (s.includes('junk') || s.includes('invalid')) return 'junk';
  if (s.includes('ambiguous') || s.includes('partial')) return 'ambiguous';
  if (s.includes('valid') || s.includes('good')) return 'valid';
  if (s.includes('review')) return 'needs_review';
  if (scorePercent == null) return 'needs_review';
  if (scorePercent >= 80) return 'valid';
  if (scorePercent >= 50) return 'ambiguous';
  return 'junk';
}

/**
 * Extract address intelligence fields from Shiprocket orders/show root.
 * @param {object} root
 */
function extractAddressIntelligenceFromShowRoot(root) {
  if (!root || typeof root !== 'object') return null;
  const d = root.data && typeof root.data === 'object' && !Array.isArray(root.data) ? root.data : root;
  return {
    address_score: d.address_score ?? d.addressScore ?? null,
    address_category: d.address_category ?? d.addressCategory ?? null,
    address_risk: d.address_risk ?? d.addressRisk ?? null,
    rto_risk: d.rto_risk ?? d.rtoRisk ?? null
  };
}

module.exports = {
  CATEGORY_LABELS,
  normalizeScorePercent,
  normalizeCategory,
  extractAddressIntelligenceFromShowRoot
};
