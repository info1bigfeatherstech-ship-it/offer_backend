/**
 * Centralized inventory release for orders that reserved stock at checkout.
 * Mirrors createOrder decrement: only when variant.inventory.trackInventory is truthy.
 */
const mongoose = require('mongoose');
const Product = require('../models/Product');
const logger = require('../utils/logger');

/**
 * @param {unknown} v
 * @returns {mongoose.Types.ObjectId | null}
 */
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
 * Same rule as createOrder stock decrement.
 * @param {object} variant
 */
function didCheckoutReserveStock(variant) {
  return Boolean(variant?.inventory?.trackInventory);
}

/**
 * @param {import('mongoose').Document | object} order — must have `items` with productId, variantId, quantity
 * @param {import('mongoose').ClientSession | null} [session]
 * @returns {Promise<void>}
 */
/**
 * Release reserved stock for specific lines (qty = units to return to catalog).
 * @param {Array<{ productId: unknown, variantId: unknown, quantity: number }>} lines
 * @param {import('mongoose').ClientSession | null} [session]
 */
async function releaseReservedInventoryForLines(lines, session = null) {
  if (!Array.isArray(lines) || lines.length === 0) return;

  for (const item of lines) {
    const pid = toObjectId(item.productId?._id || item.productId);
    const vid = toObjectId(item.variantId?._id || item.variantId);
    if (!pid || !vid) {
      logger.warn('[orderInventory] release skipped: missing productId or variantId', {
        productId: item.productId != null ? String(item.productId) : null,
        variantId: item.variantId != null ? String(item.variantId) : null
      });
      continue;
    }

    try {
      const product = await Product.findById(pid).session(session);
      if (!product) {
        logger.warn('[orderInventory] release skipped: product not found', { productId: String(pid) });
        continue;
      }

      const variant = (product.variants || []).find((v) => String(v._id) === String(vid));
      if (!variant) {
        logger.warn('[orderInventory] release skipped: variant not on product', {
          productId: String(pid),
          variantId: String(vid)
        });
        continue;
      }

      if (!didCheckoutReserveStock(variant)) {
        continue;
      }

      const qty = Number(item.quantity);
      if (!Number.isFinite(qty) || qty <= 0) {
        logger.warn('[orderInventory] release skipped: bad quantity', { quantity: item.quantity });
        continue;
      }

      const prevQty = Number(variant.inventory?.quantity || 0);
      const trackInventory = variant.inventory?.trackInventory !== false;

      /**
       * arrayFilters avoids brittle positional `$` matching when _id types differ (string vs ObjectId).
       * createOrder uses: { _id, 'variants._id': variant._id } — we align with explicit arrayFilters.
       */
      const res = await Product.updateOne(
        { _id: pid },
        { $inc: { 'variants.$[v].inventory.quantity': qty } },
        { arrayFilters: [{ 'v._id': vid }], session }
      );

      if (res.matchedCount === 0) {
        logger.warn('[orderInventory] release: no document matched', {
          productId: String(pid),
          variantId: String(vid)
        });
      } else {
        try {
          const {
            isRestockTransition,
            scheduleRestockNotifications
          } = require('./oosRestockNotify.service');
          if (isRestockTransition(prevQty, prevQty + qty, trackInventory, {
            minimumOrderQuantity: variant.minimumOrderQuantity
          })) {
            scheduleRestockNotifications({
              productId: pid,
              variantId: vid,
              productSlug: product.slug,
              productName: product.name,
              variantSku: variant.sku || null
            });
          }
        } catch (notifyErr) {
          logger.warn('[orderInventory] restock notify schedule failed', {
            message: notifyErr.message,
            productId: String(pid),
            variantId: String(vid)
          });
        }
      }
    } catch (err) {
      logger.error('[orderInventory] release failed', {
        message: err.message,
        productId: String(pid),
        variantId: String(vid)
      });
      throw err;
    }
  }
}

/**
 * @param {import('mongoose').Document | object} order — must have `items` with productId, variantId, quantity
 * @param {import('mongoose').ClientSession | null} [session]
 * @returns {Promise<void>}
 */
async function releaseReservedInventoryForOrder(order, session = null) {
  const items = order?.items;
  if (!Array.isArray(items) || items.length === 0) return;
  await releaseReservedInventoryForLines(items, session);
}

/**
 * Re-decrement stock after an unpaid terminal path released it but money later captured.
 * Fail-soft: returns per-line results; does not throw on insufficient stock.
 *
 * @param {import('mongoose').Document | object} order
 * @param {import('mongoose').ClientSession | null} [session]
 * @returns {Promise<{ attempted: number, reserved: number, skipped: number, shortages: Array<object> }>}
 */
async function reserveInventoryForOrder(order, session = null) {
  const items = order?.items;
  const summary = { attempted: 0, reserved: 0, skipped: 0, shortages: [] };
  if (!Array.isArray(items) || items.length === 0) return summary;

  for (const item of items) {
    const pid = toObjectId(item.productId?._id || item.productId);
    const vid = toObjectId(item.variantId?._id || item.variantId);
    const qty = Number(item.quantity);
    if (!pid || !vid || !Number.isFinite(qty) || qty <= 0) {
      summary.skipped += 1;
      continue;
    }

    summary.attempted += 1;
    try {
      const product = await Product.findById(pid).session(session);
      if (!product) {
        summary.skipped += 1;
        continue;
      }
      const variant = (product.variants || []).find((v) => String(v._id) === String(vid));
      if (!variant || !didCheckoutReserveStock(variant)) {
        summary.skipped += 1;
        continue;
      }

      const res = await Product.updateOne(
        { _id: pid },
        { $inc: { 'variants.$[v].inventory.quantity': -qty } },
        {
          arrayFilters: [
            {
              'v._id': vid,
              'v.inventory.trackInventory': true,
              'v.inventory.quantity': { $gte: qty }
            }
          ],
          session
        }
      );

      if (res.modifiedCount > 0) {
        summary.reserved += 1;
      } else {
        summary.shortages.push({
          productId: String(pid),
          variantId: String(vid),
          quantity: qty
        });
        logger.warn('[orderInventory] re-reserve shortage after payment recovery', {
          orderId: order.orderId || null,
          productId: String(pid),
          variantId: String(vid),
          quantity: qty
        });
      }
    } catch (err) {
      summary.skipped += 1;
      logger.error('[orderInventory] re-reserve failed', {
        message: err.message,
        productId: String(pid),
        variantId: String(vid)
      });
    }
  }

  return summary;
}

module.exports = {
  releaseReservedInventoryForOrder,
  releaseReservedInventoryForLines,
  reserveInventoryForOrder
};
