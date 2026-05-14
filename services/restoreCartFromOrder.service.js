/**
 * After an unpaid checkout order is voided (e.g. payment hold timeout), merge its
 * line items back into the user's cart. Cart was cleared at order creation.
 */
const mongoose = require('mongoose');
const Cart = require('../models/cart');
const logger = require('../utils/logger');

function toObjectId(v) {
  if (v == null) return null;
  if (v instanceof mongoose.Types.ObjectId) return v;
  const s = String(v);
  if (mongoose.Types.ObjectId.isValid(s) && s.length === 24) {
    return new mongoose.Types.ObjectId(s);
  }
  return null;
}

/**
 * @param {mongoose.Types.ObjectId} userId
 * @param {Array<{ productId?: unknown, variantId?: unknown, quantity?: unknown, priceSnapshot?: object, variantAttributesSnapshot?: unknown[] }>} orderItems
 * @param {import('mongoose').ClientSession | null} [session]
 */
async function mergeOrderLineItemsIntoUserCart(userId, orderItems, session = null) {
  if (!userId || !Array.isArray(orderItems) || orderItems.length === 0) return;

  let cart = await Cart.findOne({ userId }).session(session);
  if (!cart) {
    cart = new Cart({ userId, items: [] });
  }

  let mergedLines = 0;

  for (const item of orderItems) {
    const pid = toObjectId(item.productId?._id || item.productId);
    const vid = toObjectId(item.variantId?._id || item.variantId);
    const qty = Number(item.quantity);
    if (!pid || !vid || !Number.isFinite(qty) || qty <= 0) continue;

    const ps = item.priceSnapshot || {};
    const baseNum = Number(ps.base);
    const saleNum = ps.sale != null ? Number(ps.sale) : NaN;
    if (!(baseNum > 0) && !Number.isFinite(saleNum)) {
      logger.warn('[restoreCartFromOrder] skip line: no usable price snapshot', {
        productId: String(pid),
        variantId: String(vid)
      });
      continue;
    }
    const priceSnapshot = {
      base: baseNum > 0 ? baseNum : Math.max(1, saleNum),
      sale:
        Number.isFinite(saleNum) && saleNum > 0 && (baseNum <= 0 || saleNum < baseNum) ? saleNum : null,
      saleStartDate: null,
      saleEndDate: null
    };

    const variantAttributesSnapshot = Array.isArray(item.variantAttributesSnapshot)
      ? item.variantAttributesSnapshot.map((x) => ({
          key: x && x.key != null ? String(x.key) : '',
          value: x && x.value != null ? String(x.value) : ''
        }))
      : [];

    const existing = cart.items.find(
      (it) => String(it.productId) === String(pid) && String(it.variantId) === String(vid)
    );
    if (existing) {
      existing.quantity += qty;
      existing.priceSnapshot = priceSnapshot;
      existing.variantAttributesSnapshot = variantAttributesSnapshot;
    } else {
      cart.items.push({
        productId: pid,
        variantId: vid,
        quantity: qty,
        priceSnapshot,
        variantAttributesSnapshot
      });
    }
    mergedLines += 1;
  }

  if (mergedLines === 0) return;

  cart.markModified('items');
  cart.calculateTotal();
  await cart.save({ session });
  logger.info('[restoreCartFromOrder] Merged timed-out order lines into cart', {
    userId: String(userId),
    lines: mergedLines
  });
}

module.exports = { mergeOrderLineItemsIntoUserCart };
