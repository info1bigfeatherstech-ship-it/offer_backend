/**
 * Enforces storefront scope for admin operational APIs.
 * Backward compatible: missing scope on user doc => ecomm only.
 */

const { STOREFRONT_HEADER_ALIASES } = require('../constants/storefrontHeaders');
const { buildOrderMatchForStorefront } = require('../utils/adminOrderScope');

const VALID_STOREFRONTS = new Set(['ecomm', 'wholesale']);

function normalizeAllowedStorefronts(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return ['ecomm'];
  const deduped = [];
  for (const v of raw) {
    const key = String(v || '').toLowerCase().trim();
    if (!VALID_STOREFRONTS.has(key)) continue;
    if (!deduped.includes(key)) deduped.push(key);
  }
  return deduped.length ? deduped : ['ecomm'];
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
  // If frontend did not send storefront and user is single-scope, infer that scope.
  // This prevents wholesale admins from accidentally falling back to ecomm default.
  const requestedStorefront = hasExplicitHeader
    ? (req.storefront === 'wholesale' ? 'wholesale' : 'ecomm')
    : (allowedStorefronts.length === 1 ? allowedStorefronts[0] : 'ecomm');

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
    /** Orders: userType + storefront (ecomm includes legacy missing storefront). */
    orderMatch: buildOrderMatchForStorefront(requestedStorefront),
    userMatch:
      requestedStorefront === 'wholesale'
        ? {
            $or: [{ accountScope: 'wholesale' }, { userType: 'wholesaler' }, { role: 'wholesaler' }]
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
              { role: { $nin: ['wholesaler', 'admin', 'product_manager', 'order_manager', 'marketing_manager'] } }
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

