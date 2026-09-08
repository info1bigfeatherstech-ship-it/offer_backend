/**
 * Public storefront origins for emails / web-push deep links / icons.
 *
 * Prefer dedicated public URL envs so local FRONTEND_URL=localhost does not
 * leak into production notification click targets.
 *
 * Ecomm default:  https://offerwalebaba.com
 * Wholesale default: https://offerwalebaba.in
 *
 * Optional: PUSH_USE_LOCAL_FRONTEND=true — allow localhost from FRONTEND_URL
 * for local push click testing only.
 */

const ECOMM_PUBLIC_DEFAULT = 'https://offerwalebaba.com';
const WHOLESALE_PUBLIC_DEFAULT = 'https://offerwalebaba.in';

function isLocalDevHost(url) {
  try {
    const host = new URL(String(url)).hostname.toLowerCase();
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === '::1' ||
      host.endsWith('.local')
    );
  } catch {
    return false;
  }
}

function splitCandidates(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Resolve a single absolute frontend origin.
 * Skips localhost/private hosts unless allowLocal is true.
 */
function pickPrimaryBaseUrl(raw, fallback = ECOMM_PUBLIC_DEFAULT, { allowLocal = false } = {}) {
  const parts = splitCandidates(raw);
  for (const part of parts) {
    if (!allowLocal && isLocalDevHost(part)) continue;
    return part.replace(/\/$/, '');
  }
  if (allowLocal && parts.length) {
    return parts[0].replace(/\/$/, '');
  }
  if (fallback == null || fallback === '') return null;
  return String(fallback || ECOMM_PUBLIC_DEFAULT).replace(/\/$/, '');
}

function pushAllowsLocalFrontend() {
  return String(process.env.PUSH_USE_LOCAL_FRONTEND || '').trim().toLowerCase() === 'true';
}

/**
 * Public origin for a storefront (push / email / CTA links).
 */
function getStorefrontFrontendBase(storefront = 'ecomm') {
  const allowLocal = pushAllowsLocalFrontend();

  if (storefront === 'wholesale') {
    return pickPrimaryBaseUrl(
      process.env.WHOLESALE_PUBLIC_URL ||
        process.env.WHOLESALE_FRONTEND_URL ||
        process.env.WHOLESALER_FRONTEND_URL ||
        process.env.FRONTEND_URL ||
        process.env.STORE_URL,
      WHOLESALE_PUBLIC_DEFAULT,
      { allowLocal }
    );
  }

  return pickPrimaryBaseUrl(
    process.env.ECOMM_PUBLIC_URL ||
      process.env.ECOMM_FRONTEND_URL ||
      process.env.STORE_PUBLIC_URL ||
      process.env.FRONTEND_URL ||
      process.env.STORE_URL,
    ECOMM_PUBLIC_DEFAULT,
    { allowLocal }
  );
}

/** Join origin + path/hash safely. */
function buildStorefrontUrl(storefront, pathOrUrl = '/') {
  if (/^https?:\/\//i.test(String(pathOrUrl || ''))) {
    return String(pathOrUrl).trim();
  }
  const base = getStorefrontFrontendBase(storefront);
  const path = String(pathOrUrl || '/').trim() || '/';
  if (path.startsWith('#')) return `${base}/${path}`;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

/** Absolute URL for push icons/badges (OS often ignores relative paths). */
function resolvePushAssetUrl(assetPath, storefront = 'ecomm') {
  const path = String(assetPath || '/pwa-192x192.png').trim() || '/pwa-192x192.png';
  if (/^https?:\/\//i.test(path)) return path;
  return buildStorefrontUrl(storefront, path);
}

module.exports = {
  ECOMM_PUBLIC_DEFAULT,
  WHOLESALE_PUBLIC_DEFAULT,
  isLocalDevHost,
  pickPrimaryBaseUrl,
  getStorefrontFrontendBase,
  buildStorefrontUrl,
  resolvePushAssetUrl,
};
