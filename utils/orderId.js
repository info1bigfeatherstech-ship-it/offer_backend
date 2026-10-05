/**
 * Channel-specific public order IDs.
 * OWB-WH-* — wholesale storefront + wholesaler account
 * OWB-ECOMM-* — ecommerce storefront or non-wholesaler checkout
 * OWB-DS-* — dropship channel orders
 *
 * Suffix is exactly 6 random digits (000000–999999).
 * The digit suffix must be unique across ALL prefixes (no shared 6-digit
 * sequence between ecomm, wholesale, and dropship panels).
 */

const crypto = require('crypto');

const PREFIX_WHOLESALE = 'OWB-WH-';
const PREFIX_ECOMM = 'OWB-ECOMM-';
const PREFIX_DROPSHIP = 'OWB-DS-';
const ORDER_ID_DIGIT_LEN = 6;
const ORDER_ID_DIGIT_MOD = 10 ** ORDER_ID_DIGIT_LEN;
const DEFAULT_ALLOCATE_ATTEMPTS = 32;

function normalizeStorefront(value) {
  const s = String(value || 'ecomm').toLowerCase().trim();
  if (s === 'wholesale') return 'wholesale';
  if (s === 'dropship') return 'dropship';
  return 'ecomm';
}

function normalizeOrderUserType(value) {
  return String(value || 'normal').toLowerCase() === 'wholesaler' ? 'wholesaler' : 'normal';
}

/**
 * @param {{ storefront?: string, userType?: string }} input
 * @returns {typeof PREFIX_WHOLESALE | typeof PREFIX_ECOMM | typeof PREFIX_DROPSHIP}
 */
function resolveOrderIdPrefix({ storefront, userType } = {}) {
  const sf = normalizeStorefront(storefront);
  if (sf === 'dropship') {
    return PREFIX_DROPSHIP;
  }
  const ut = normalizeOrderUserType(userType);
  if (sf === 'wholesale' && ut === 'wholesaler') {
    return PREFIX_WHOLESALE;
  }
  return PREFIX_ECOMM;
}

/** @returns {string} zero-padded 6-digit string */
function randomOrderIdDigits() {
  const n =
    typeof crypto.randomInt === 'function'
      ? crypto.randomInt(0, ORDER_ID_DIGIT_MOD)
      : crypto.randomBytes(3).readUIntBE(0, 3) % ORDER_ID_DIGIT_MOD;
  return String(n).padStart(ORDER_ID_DIGIT_LEN, '0');
}

/**
 * All channel IDs that would share the same 6-digit suffix.
 * @param {string} digits
 * @returns {string[]}
 */
function orderIdsForDigitSuffix(digits) {
  const d = String(digits || '').padStart(ORDER_ID_DIGIT_LEN, '0').slice(-ORDER_ID_DIGIT_LEN);
  return [`${PREFIX_ECOMM}${d}`, `${PREFIX_WHOLESALE}${d}`, `${PREFIX_DROPSHIP}${d}`];
}

/**
 * @param {{ storefront?: string, userType?: string }} input
 * @returns {string} e.g. OWB-ECOMM-482913 or OWB-WH-019284
 */
function generateOrderId({ storefront, userType } = {}) {
  const prefix = resolveOrderIdPrefix({ storefront, userType });
  return `${prefix}${randomOrderIdDigits()}`;
}

/**
 * Allocate a unique order id whose 6-digit suffix is free under BOTH prefixes.
 * @param {{
 *   storefront?: string,
 *   userType?: string,
 *   maxAttempts?: number,
 *   isSuffixTaken: (digits: string) => Promise<boolean>
 * }} opts
 * @returns {Promise<string>}
 */
async function allocateUniqueOrderId({
  storefront,
  userType,
  maxAttempts = DEFAULT_ALLOCATE_ATTEMPTS,
  isSuffixTaken
} = {}) {
  if (typeof isSuffixTaken !== 'function') {
    throw new Error('allocateUniqueOrderId requires isSuffixTaken(digits)');
  }
  const prefix = resolveOrderIdPrefix({ storefront, userType });
  const attempts = Math.max(1, Number(maxAttempts) || DEFAULT_ALLOCATE_ATTEMPTS);
  for (let i = 0; i < attempts; i++) {
    const digits = randomOrderIdDigits();
    // eslint-disable-next-line no-await-in-loop
    const taken = await isSuffixTaken(digits);
    if (!taken) {
      return `${prefix}${digits}`;
    }
  }
  const err = new Error('Could not allocate a unique order ID');
  err.code = 'ORDER_ID_GENERATION_FAILED';
  throw err;
}

module.exports = {
  PREFIX_WHOLESALE,
  PREFIX_ECOMM,
  PREFIX_DROPSHIP,
  ORDER_ID_DIGIT_LEN,
  DEFAULT_ALLOCATE_ATTEMPTS,
  normalizeStorefront,
  normalizeOrderUserType,
  resolveOrderIdPrefix,
  randomOrderIdDigits,
  orderIdsForDigitSuffix,
  generateOrderId,
  allocateUniqueOrderId
};
