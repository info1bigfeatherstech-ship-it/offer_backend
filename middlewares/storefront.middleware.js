const { resolveStorefront } = require('../config/storefront.config');
const { isOrderStaffRequest } = require('../utils/checkoutFlow');
const logger = require('../utils/logger');

/**
 * Sets req.storefront to 'ecomm' | 'wholesale' for all flows.
 */
function resolveStorefrontMiddleware(req, res, next) {
  try {
    req.storefront = resolveStorefront(req);
    return next();
  } catch (err) {
    logger.error('[storefront] resolveStorefrontMiddleware failed', {
      message: err?.message || String(err)
    });
    return res.status(500).json({
      success: false,
      code: 'STOREFRONT_RESOLVE_FAILED',
      message: 'Could not resolve storefront'
    });
  }
}

/**
 * Who may use wholesale storefront transactional APIs (cart / checkout / customer order routes).
 *
 * - wholesaler customers: yes (buyer flows)
 * - order staff (admin, order_manager): yes — wholesale admin panel reuses GET order/track
 * - product_manager / marketing_manager / retail user: no
 *
 * Admin-only routes still use authorizeRoles(...); this guard only unblocks shared read paths.
 *
 * @param {import('express').Request} req
 * @returns {{ allowed: boolean, reason: string }}
 */
function evaluateWholesaleTransactionalAccess(req) {
  const userType = String(req?.userType || '').trim().toLowerCase();
  if (userType === 'wholesaler') {
    return { allowed: true, reason: 'wholesaler' };
  }
  if (isOrderStaffRequest(req)) {
    return { allowed: true, reason: 'order_staff' };
  }
  return { allowed: false, reason: 'denied' };
}

function evaluateEcommTransactionalAccess(req) {
  const userType = String(req?.userType || '').trim().toLowerCase();
  if (userType === 'wholesaler') {
    return { allowed: false, reason: 'wholesaler_on_ecomm' };
  }
  return { allowed: true, reason: 'ecomm_customer' };
}

/**
 * Option B policy (updated):
 * Wholesale storefront transactional APIs are for wholesaler buyers OR order staff.
 * Ecomm storefront transactional APIs reject wholesale customer tokens.
 */
function requireWholesaleUserForWholesaleStorefront(req, res, next) {
  try {
    const storefront = req.storefront || resolveStorefront(req);
    req.storefront = storefront;

    if (storefront === 'wholesale') {
      const decision = evaluateWholesaleTransactionalAccess(req);
      if (decision.allowed) {
        return next();
      }
      return res.status(403).json({
        success: false,
        code: 'STOREFRONT_SCOPE_FORBIDDEN',
        message: 'Wholesale storefront checkout is allowed only for wholesaler accounts.'
      });
    }

    const ecommDecision = evaluateEcommTransactionalAccess(req);
    if (!ecommDecision.allowed) {
      return res.status(403).json({
        success: false,
        code: 'STOREFRONT_SCOPE_FORBIDDEN',
        message: 'This wholesale account cannot use the e-commerce storefront. Please login on the wholesale app.'
      });
    }

    return next();
  } catch (err) {
    logger.error('[storefront] requireWholesaleUserForWholesaleStorefront failed', {
      message: err?.message || String(err),
      userId: req?.userId || null
    });
    return res.status(500).json({
      success: false,
      code: 'STOREFRONT_GUARD_ERROR',
      message: 'Could not authorize wholesale storefront access'
    });
  }
}

module.exports = {
  resolveStorefrontMiddleware,
  requireWholesaleUserForWholesaleStorefront,
  evaluateWholesaleTransactionalAccess,
  evaluateEcommTransactionalAccess
};
