/**
 * Channel-specific public order IDs.
 * OWB-WHOLE-* — wholesale storefront + wholesaler account
 * OWB-ECOMM-* — ecommerce storefront or non-wholesaler checkout
 */

const crypto = require('crypto');

const PREFIX_WHOLESALE = 'OWB-WH-';
const PREFIX_ECOMM = 'OWB-ECOMM-';

function normalizeStorefront(value) {
  const s = String(value || 'ecomm').toLowerCase().trim();
  return s === 'wholesale' ? 'wholesale' : 'ecomm';
}

function normalizeOrderUserType(value) {
  return String(value || 'normal').toLowerCase() === 'wholesaler' ? 'wholesaler' : 'normal';
}

/**
 * @param {{ storefront?: string, userType?: string }} input
 * @returns {typeof PREFIX_WHOLESALE | typeof PREFIX_ECOMM}
 */
function resolveOrderIdPrefix({ storefront, userType } = {}) {
  const sf = normalizeStorefront(storefront);
  const ut = normalizeOrderUserType(userType);
  if (sf === 'wholesale' && ut === 'wholesaler') {
    return PREFIX_WHOLESALE;
  }
  return PREFIX_ECOMM;
}

/**
 * @param {{ storefront?: string, userType?: string }} input
 * @returns {string}
 */
function generateOrderId({ storefront, userType } = {}) {
  const prefix = resolveOrderIdPrefix({ storefront, userType });
  if (typeof crypto.randomUUID === 'function') {
    return `${prefix}${crypto.randomUUID().replace(/-/g, '').slice(0, 18).toUpperCase()}`;
  }
  return `${prefix}${crypto.randomBytes(10).toString('hex').toUpperCase()}`;
}

module.exports = {
  PREFIX_WHOLESALE,
  PREFIX_ECOMM,
  normalizeStorefront,
  normalizeOrderUserType,
  resolveOrderIdPrefix,
  generateOrderId
};
