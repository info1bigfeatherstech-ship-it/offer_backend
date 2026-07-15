/**
 * Find / create carts scoped by storefront (ecomm-safe legacy match).
 * findCartForStorefront returns a Query (chain .populate / .session / .lean).
 */
const Cart = require('../models/cart');
const {
  normalizeCustomerStorefront,
  mergeCustomerStorefrontFilter
} = require('../utils/customerStorefrontScope');

/**
 * @param {import('mongoose').Types.ObjectId|string} userId
 * @param {'ecomm'|'wholesale'|string|null|undefined} storefront
 * @returns {import('mongoose').Query}
 */
function findCartForStorefront(userId, storefront) {
  const sf = normalizeCustomerStorefront(storefront);
  return Cart.findOne(mergeCustomerStorefrontFilter({ userId }, sf));
}

/**
 * @param {import('mongoose').Types.ObjectId|string} userId
 * @param {'ecomm'|'wholesale'|string|null|undefined} storefront
 * @param {{ session?: import('mongoose').ClientSession|null, save?: boolean }} [opts]
 */
async function findOrCreateCartForStorefront(userId, storefront, opts = {}) {
  const sf = normalizeCustomerStorefront(storefront);
  let q = findCartForStorefront(userId, sf);
  if (opts.session) q = q.session(opts.session);
  let cart = await q;
  if (cart) return cart;

  cart = new Cart({ userId, storefront: sf, items: [] });
  if (opts.save) {
    if (opts.session) await cart.save({ session: opts.session });
    else await cart.save();
  }
  return cart;
}

module.exports = {
  findCartForStorefront,
  findOrCreateCartForStorefront
};
