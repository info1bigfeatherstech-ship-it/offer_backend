/**
 * Storefront scoping for product reviews (ecomm | wholesale).
 * Legacy docs without `storefront` are treated as ecomm.
 */

function normalizeReviewStorefront(raw) {
  return String(raw || '').toLowerCase().trim() === 'wholesale' ? 'wholesale' : 'ecomm';
}

/**
 * Resolve storefront from admin scope, then request storefront, else ecomm.
 * @param {import('express').Request|null|undefined} req
 */
function resolveReviewStorefrontFromReq(req) {
  if (req?.adminScope?.storefront) {
    return normalizeReviewStorefront(req.adminScope.storefront);
  }
  return normalizeReviewStorefront(req?.storefront);
}

/**
 * Mongo filter fragment for reviews belonging to a storefront.
 * @param {'ecomm'|'wholesale'|string} storefront
 */
function buildReviewStorefrontMatch(storefront) {
  const sf = normalizeReviewStorefront(storefront);
  if (sf === 'wholesale') {
    return { storefront: 'wholesale' };
  }
  return {
    $or: [{ storefront: 'ecomm' }, { storefront: { $exists: false } }, { storefront: null }]
  };
}

/**
 * @param {import('mongoose').FilterQuery<any>} base
 * @param {'ecomm'|'wholesale'|string} storefront
 */
function mergeReviewStorefrontFilter(base, storefront) {
  const scope = buildReviewStorefrontMatch(storefront);
  const baseFilter = base && typeof base === 'object' ? base : {};
  if (!Object.keys(baseFilter).length) return scope;
  return { $and: [baseFilter, scope] };
}

module.exports = {
  normalizeReviewStorefront,
  resolveReviewStorefrontFromReq,
  buildReviewStorefrontMatch,
  mergeReviewStorefrontFilter
};
