const { resolveStorefront } = require('../config/storefront.config');

/**
 * Sets req.storefront to 'ecomm' | 'wholesale' for all flows.
 */
function resolveStorefrontMiddleware(req, res, next) {
  req.storefront = resolveStorefront(req);
  next();
}

/**
 * Option B policy:
 * wholesale storefront transactional APIs are allowed only for wholesaler users.
 * Prevents retail identity from using wholesale cart/checkout/order flows.
 */
function requireWholesaleUserForWholesaleStorefront(req, res, next) {
  const storefront = req.storefront || resolveStorefront(req);
  if (storefront !== 'wholesale') return next();

  const normalizedUserType = String(req.userType || '').trim().toLowerCase();
  if (normalizedUserType === 'wholesaler') return next();

  return res.status(403).json({
    success: false,
    code: 'STOREFRONT_SCOPE_FORBIDDEN',
    message: 'Wholesale storefront checkout is allowed only for wholesaler accounts.'
  });
}

module.exports = {
  resolveStorefrontMiddleware,
  requireWholesaleUserForWholesaleStorefront
};
