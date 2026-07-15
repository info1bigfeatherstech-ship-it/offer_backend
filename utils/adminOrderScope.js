/**
 * Admin order storefront scope helpers.
 * Used by admin orders / RTO / returns / fulfillment / pending-edit.
 *
 * Ecomm safety: legacy orders may omit `storefront` — treat missing/null as ecomm
 * when scope is ecomm. Wholesale always requires explicit storefront=wholesale.
 */

/**
 * @param {'ecomm'|'wholesale'|string} storefront
 * @returns {import('mongoose').FilterQuery<any>}
 */
function buildOrderMatchForStorefront(storefront) {
  const sf = String(storefront || 'ecomm').toLowerCase().trim() === 'wholesale' ? 'wholesale' : 'ecomm';

  if (sf === 'wholesale') {
    return { userType: 'wholesaler', storefront: 'wholesale' };
  }

  // Ecomm + legacy docs without storefront field (pre-multi-storefront).
  return {
    userType: 'normal',
    $or: [{ storefront: 'ecomm' }, { storefront: { $exists: false } }, { storefront: null }]
  };
}

/**
 * @param {import('express').Request|null|undefined} req
 * @returns {import('mongoose').FilterQuery<any>}
 */
function getAdminOrderMatch(req) {
  if (req?.adminScope?.orderMatch && Object.keys(req.adminScope.orderMatch).length) {
    return req.adminScope.orderMatch;
  }
  const storefront = req?.adminScope?.storefront || req?.storefront || 'ecomm';
  return buildOrderMatchForStorefront(storefront);
}

/**
 * @param {import('express').Request|null|undefined} req
 * @returns {'ecomm'|'wholesale'}
 */
function getAdminStorefrontLabel(req) {
  const sf = req?.adminScope?.storefront || req?.storefront || 'ecomm';
  return String(sf).toLowerCase() === 'wholesale' ? 'wholesale' : 'ecomm';
}

/**
 * Merge a base Mongo filter with admin order scope (never clobber with empty).
 * @param {import('mongoose').FilterQuery<any>} base
 * @param {import('mongoose').FilterQuery<any>|null|undefined} scopeMatch
 */
function mergeOrderScopeFilter(base, scopeMatch) {
  const baseFilter = base && typeof base === 'object' ? base : {};
  if (!scopeMatch || typeof scopeMatch !== 'object' || !Object.keys(scopeMatch).length) {
    return baseFilter;
  }
  if (!Object.keys(baseFilter).length) return scopeMatch;
  return { $and: [baseFilter, scopeMatch] };
}

/**
 * @param {import('express').Request|null|undefined} req
 * @param {import('mongoose').FilterQuery<any>} base
 */
function mergeAdminOrderFilter(req, base = {}) {
  return mergeOrderScopeFilter(base, getAdminOrderMatch(req));
}

/**
 * Whether an order document belongs to the active admin storefront scope.
 * @param {object|null|undefined} order
 * @param {import('express').Request|string} reqOrStorefront
 */
function orderMatchesAdminScope(order, reqOrStorefront) {
  if (!order) return false;
  const storefront =
    typeof reqOrStorefront === 'string'
      ? reqOrStorefront
      : getAdminStorefrontLabel(reqOrStorefront);

  const userType = String(order.userType || '').toLowerCase();
  const orderSfRaw = order.storefront;
  const orderSf =
    orderSfRaw == null || String(orderSfRaw).trim() === ''
      ? null
      : String(orderSfRaw).toLowerCase().trim();

  if (storefront === 'wholesale') {
    return userType === 'wholesaler' && orderSf === 'wholesale';
  }

  // ecomm
  if (userType !== 'normal') return false;
  return orderSf === null || orderSf === 'ecomm';
}

/**
 * @param {object|null|undefined} order
 * @param {import('express').Request} req
 * @returns {{ ok: true } | { ok: false, statusCode: number, code: string, message: string }}
 */
function assertOrderInAdminScope(order, req) {
  if (!order) {
    return {
      ok: false,
      statusCode: 404,
      code: 'ORDER_NOT_FOUND',
      message: 'Order not found'
    };
  }
  if (!orderMatchesAdminScope(order, req)) {
    return {
      ok: false,
      statusCode: 404,
      code: 'ORDER_NOT_FOUND',
      message: 'Order not found'
    };
  }
  return { ok: true };
}

module.exports = {
  buildOrderMatchForStorefront,
  getAdminOrderMatch,
  getAdminStorefrontLabel,
  mergeOrderScopeFilter,
  mergeAdminOrderFilter,
  orderMatchesAdminScope,
  assertOrderInAdminScope
};
