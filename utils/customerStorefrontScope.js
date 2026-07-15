/**
 * Storefront scoping for customer Address + Cart (ecomm | wholesale).
 * Legacy docs without `storefront` are treated as ecomm (live ecomm-safe).
 */

function normalizeCustomerStorefront(raw) {
  return String(raw || '').toLowerCase().trim() === 'wholesale' ? 'wholesale' : 'ecomm';
}

/**
 * @param {import('express').Request|null|undefined} req
 */
function resolveCustomerStorefrontFromReq(req) {
  if (req?.adminScope?.storefront) {
    return normalizeCustomerStorefront(req.adminScope.storefront);
  }
  return normalizeCustomerStorefront(req?.storefront);
}

/**
 * @param {'ecomm'|'wholesale'|string} storefront
 */
function buildCustomerStorefrontMatch(storefront) {
  const sf = normalizeCustomerStorefront(storefront);
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
function mergeCustomerStorefrontFilter(base, storefront) {
  const scope = buildCustomerStorefrontMatch(storefront);
  const baseFilter = base && typeof base === 'object' ? base : {};
  if (!Object.keys(baseFilter).length) return scope;
  return { $and: [baseFilter, scope] };
}

/**
 * Lean/doc address belongs to requested storefront?
 * @param {{ storefront?: string|null }|null|undefined} address
 * @param {'ecomm'|'wholesale'|string} storefront
 */
function addressBelongsToStorefront(address, storefront) {
  if (!address) return false;
  const want = normalizeCustomerStorefront(storefront);
  const have = address.storefront;
  if (want === 'wholesale') {
    return String(have || '').toLowerCase() === 'wholesale';
  }
  return have == null || have === '' || String(have).toLowerCase() === 'ecomm';
}

module.exports = {
  normalizeCustomerStorefront,
  resolveCustomerStorefrontFromReq,
  buildCustomerStorefrontMatch,
  mergeCustomerStorefrontFilter,
  addressBelongsToStorefront
};
