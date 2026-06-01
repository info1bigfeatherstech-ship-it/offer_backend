/**
 * Drop stale cart lines (missing product/variant or delisted on storefront).
 * GET /cart hides these; checkout must not fail on ghost lines still in MongoDB.
 */

const mongoose = require('mongoose');
const Product = require('../models/Product');
const {
  mongoCatalogAnd,
  isProductListedOnStorefront,
  isVariantListedOnStorefront
} = require('../utils/storefrontCatalog');

const CART_PRODUCT_SELECT =
  'name slug variants shipping hsnCode gstRate isFragile status channelStatus';

function resolveCartItemProductId(cartItem) {
  const raw = cartItem?.productId;
  if (raw == null) return null;
  if (typeof raw === 'object' && raw._id != null) return String(raw._id);
  const s = String(raw).trim();
  if (!s || s === 'undefined' || s === 'null' || s === '[object Object]') return null;
  return mongoose.Types.ObjectId.isValid(s) ? s : null;
}

function resolveCartItemVariantId(cartItem) {
  const raw = cartItem?.variantId;
  if (raw == null) return null;
  if (typeof raw === 'object' && raw._id != null) return String(raw._id);
  const s = String(raw).trim();
  if (!s || s === 'undefined' || s === 'null') return null;
  return mongoose.Types.ObjectId.isValid(s) ? s : null;
}

/**
 * @param {object} cartItem
 * @param {'ecomm'|'wholesale'} storefront
 */
async function loadProductForCartItem(cartItem, storefront) {
  const pid = resolveCartItemProductId(cartItem);
  let product = null;
  if (pid) {
    product = await Product.findById(pid).select(CART_PRODUCT_SELECT);
  }
  const slug = cartItem?.productSlug || cartItem?._productSlug;
  if (!product && slug) {
    product = await Product.findOne(
      mongoCatalogAnd(storefront, { slug: String(slug).toLowerCase().trim() })
    ).select(CART_PRODUCT_SELECT);
  }
  return product;
}

function isCartLinePurchasable(cartItem, product, storefront) {
  if (!product || !isProductListedOnStorefront(product, storefront)) return false;
  const vid = resolveCartItemVariantId(cartItem);
  if (!vid) return false;
  const variant = (product.variants || []).find((v) => String(v._id) === vid);
  return Boolean(variant && isVariantListedOnStorefront(variant, storefront));
}

/**
 * @param {import('mongoose').Document} cart
 * @param {'ecomm'|'wholesale'} storefront
 * @param {{ persist?: boolean }} [options]
 */
async function sanitizeCartItems(cart, storefront = 'ecomm', options = {}) {
  const persist = options.persist !== false;
  if (!cart?.items?.length) {
    return { removed: [], cart, changed: false };
  }

  const kept = [];
  const removed = [];

  for (const item of cart.items) {
    const product = await loadProductForCartItem(item, storefront);
    if (isCartLinePurchasable(item, product, storefront)) {
      if (product && String(item.productId) !== String(product._id)) {
        item.productId = product._id;
      }
      kept.push(item);
    } else {
      removed.push({
        productId: resolveCartItemProductId(item),
        variantId: resolveCartItemVariantId(item),
        quantity: item.quantity
      });
    }
  }

  const changed = removed.length > 0;
  if (changed) {
    cart.items = kept;
    if (typeof cart.calculateTotal === 'function') {
      cart.calculateTotal();
    }
    if (persist) {
      cart.markModified('items');
      await cart.save();
    }
  }

  return { removed, cart, changed };
}

module.exports = {
  sanitizeCartItems,
  resolveCartItemProductId,
  resolveCartItemVariantId,
  loadProductForCartItem,
  isCartLinePurchasable,
  CART_PRODUCT_SELECT
};
