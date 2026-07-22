/**
 * Helpers for optional unique contact fields (email / phone / googleId).
 *
 * MongoDB unique indexes (even sparse) allow only ONE document with `null`.
 * Phone-only registration must omit the field entirely — never store null/"".
 */

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeOptionalEmail(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeOptionalPhone(value) {
  return String(value || '').trim();
}

/**
 * Set a unique string field to a real value, or fully unset it when blank.
 * Safe for new docs and for upgrading orphans that already have `email: null`.
 *
 * @param {import('mongoose').Document} doc
 * @param {string} path
 * @param {string} normalizedValue already trimmed (and lowercased for email)
 */
function setOrUnsetUniqueString(doc, path, normalizedValue) {
  const v = String(normalizedValue || '').trim();
  if (v) {
    doc.set(path, v);
    return;
  }
  doc.set(path, undefined);
  // Ensure existing null/empty is removed from the BSON document on save.
  if (typeof doc.$unset === 'function') {
    doc.$unset(path);
  }
}

module.exports = {
  normalizeOptionalEmail,
  normalizeOptionalPhone,
  setOrUnsetUniqueString
};
