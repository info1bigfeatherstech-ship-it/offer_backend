/**
 * Resolve a single absolute frontend origin for push/email deep links.
 * FRONTEND_URL may be comma-separated (dev + preview); use the first entry.
 */
function pickPrimaryBaseUrl(raw, fallback = 'https://offerwalebaba.com') {
  const first = String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .find(Boolean);
  if (!first) return String(fallback).replace(/\/$/, '');
  return first.replace(/\/$/, '');
}

function getStorefrontFrontendBase(storefront = 'ecomm') {
  if (storefront === 'wholesale') {
    return pickPrimaryBaseUrl(
      process.env.WHOLESALE_FRONTEND_URL ||
        process.env.WHOLESALER_FRONTEND_URL ||
        process.env.FRONTEND_URL ||
        process.env.STORE_URL,
      'https://offerwalebaba.com'
    );
  }
  return pickPrimaryBaseUrl(
    process.env.FRONTEND_URL || process.env.STORE_URL,
    'https://offerwalebaba.com'
  );
}

module.exports = {
  pickPrimaryBaseUrl,
  getStorefrontFrontendBase,
};
