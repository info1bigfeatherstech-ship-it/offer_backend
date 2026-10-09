/**
 * Enforces storefront scope for admin operational APIs.
 * Backward compatible: missing scope on user doc => ecomm only.
 */

const { STOREFRONT_HEADER_ALIASES } = require('../constants/storefrontHeaders');
const { buildOrderMatchForStorefront } = require('../utils/adminOrderScope');

const VALID_STOREFRONTS = new Set(['ecomm', 'wholesale', 'dropship']);

function readExplicitStorefrontHeader(req) {
  for (const key of STOREFRONT_HEADER_ALIASES) {
    const val = req.get(key);
    if (val != null && String(val).trim() !== '') return String(val).toLowerCase().trim();
  }
  return null;
}

function normalizeRequestedStorefront(raw) {
  const v = String(raw || '').toLowerCase().trim();
  if (v === 'wholesale' || v === 'wholesaler' || v === 'b2b') return 'wholesale';
  if (v === 'dropship' || v === 'dropshipping' || v === 'ds') return 'dropship';
  if (v === 'ecomm' || v === 'retail' || v === 'shop' || v === 'store' || v === 'b2c') return 'ecomm';
  return null;
}

function normalizeAllowedStorefronts(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return ['ecomm', 'dropship'];
  const deduped = [];
  for (const v of raw) {
    const key = String(v || '').toLowerCase().trim();
    if (!VALID_STOREFRONTS.has(key)) continue;
    if (!deduped.includes(key)) deduped.push(key);
  }
  // Dropship ops reuse ecomm warehouse/admin staff — grant at runtime without
  // requiring User.allowedStorefronts enum migration (still ecomm|wholesale only).
  if (deduped.includes('ecomm') && !deduped.includes('dropship')) {
    deduped.push('dropship');
  }
  return deduped.length ? deduped : ['ecomm', 'dropship'];
}

function _enforceAdminStorefrontScope(req, res, next, options = {}) {
  const allowedStorefronts = normalizeAllowedStorefronts(req.user?.allowedStorefronts);
  const requireExplicitHeader = options.requireExplicitHeader === true;
  const hasExplicitHeader = STOREFRONT_HEADER_ALIASES.some((h) => {
    const val = req.get(h);
    return val != null && String(val).trim() !== '';
  });
  if (requireExplicitHeader && !hasExplicitHeader) {
    return res.status(400).json({
      success: false,
      code: 'MISSING_STOREFRONT_HEADER',
      message: 'x-storefront header is required for this admin operation.'
    });
  }
  // Prefer raw header so dropship works even if customer resolveStorefront
  // stays ecomm|wholesale-only (does not change public storefront resolution).
  let requestedStorefront = 'ecomm';
  if (hasExplicitHeader) {
    const fromHeader = normalizeRequestedStorefront(readExplicitStorefrontHeader(req));
    requestedStorefront =
      fromHeader || (req.storefront === 'wholesale' ? 'wholesale' : 'ecomm');
  } else {
    // Ignore runtime-granted dropship when inferring default from single scope.
    const inferable = allowedStorefronts.filter((s) => s !== 'dropship');
    requestedStorefront = inferable.length === 1 ? inferable[0] : 'ecomm';
  }

  if (!allowedStorefronts.includes(requestedStorefront)) {
    return res.status(403).json({
      success: false,
      code: 'STOREFRONT_SCOPE_FORBIDDEN',
      message: `Access denied for storefront "${requestedStorefront}".`
    });
  }

  req.adminScope = {
    storefront: requestedStorefront,
    explicitStorefront: hasExplicitHeader ? requestedStorefront : null,
    allowedStorefronts,
    /** Orders: scoped by order.storefront (ecomm includes legacy missing storefront). */
    orderMatch: buildOrderMatchForStorefront(requestedStorefront),
    userMatch:
      requestedStorefront === 'wholesale'
        ? {
            $or: [{ accountScope: 'wholesale' }, { userType: 'wholesaler' }, { role: 'wholesaler' }]
          }
        : requestedStorefront === 'dropship'
          ? {
              // Dropship orders are placed by staff today; user panel filter is unused for DS.
              _id: { $exists: true }
            }
        : {
            $and: [
              {
                $or: [
                  { accountScope: 'ecomm' },
                  { accountScope: { $exists: false } },
                  { accountScope: null }
                ]
              },
              { userType: { $nin: ['wholesaler', 'admin'] } },
              { role: { $nin: ['wholesaler', 'admin', 'product_manager', 'order_manager', 'marketing_manager', 'inventory_manager', 'packing_viewer'] } }
            ]
          }
  };

  return next();
}

function requireAdminStorefrontScope(req, res, next) {
  return _enforceAdminStorefrontScope(req, res, next);
}

function requireStrictAdminStorefrontScope(req, res, next) {
  return _enforceAdminStorefrontScope(req, res, next, { requireExplicitHeader: true });
}

module.exports = {
  requireAdminStorefrontScope,
  requireStrictAdminStorefrontScope,
  normalizeAllowedStorefronts
};

