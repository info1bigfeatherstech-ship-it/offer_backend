/**
 * Order stock bridge: Inventory software (preferred) ↔ Mongo fallback.
 *
 * Policies (locked):
 * - Online: reserve @ create → commit @ first payment capture
 * - Advance: same (first capture commits)
 * - COD: reserve @ create → commit @ admin confirm (or legacy auto-confirm @ create)
 * - Cancel / fail / hold expiry: release if still HELD
 * - API down / misconfig: Mongo fallback
 * - True INSUFFICIENT_STOCK from inventory: fail checkout (no Mongo lie)
 * - Never cut Mongo when inventory reserve succeeded for those lines
 */

const logger = require('../utils/logger');
const {
  isInventoryStockEnabled,
  reserveStock,
  commitStock,
  releaseStock,
  normalizeProductCode
} = require('./externalInventory.service');
const {
  releaseReservedInventoryForOrder,
  releaseReservedInventoryForLines,
  reserveInventoryForOrder
} = require('./orderInventory.service');

const DEGRADED_CODES = new Set([
  'INTERNAL_STOCK_API_DISABLED',
  'INVALID_API_KEY',
  'ONLINE_WAREHOUSE_NOT_CONFIGURED',
  'NETWORK_ERROR',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ECONNABORTED',
  'ENOTFOUND'
]);

function emptyHold(extra = {}) {
  return {
    source: null,
    status: 'none',
    reservationId: null,
    inventoryReserved: false,
    mongoReserved: false,
    reason: null,
    updatedAt: new Date(),
    ...extra
  };
}

function readHold(order) {
  const h = order?.inventoryHold;
  if (!h || typeof h !== 'object') return emptyHold();
  return {
    source: h.source || null,
    status: h.status || 'none',
    reservationId: h.reservationId || null,
    inventoryReserved: Boolean(h.inventoryReserved),
    mongoReserved: Boolean(h.mongoReserved),
    reason: h.reason || null,
    updatedAt: h.updatedAt || null
  };
}

function writeHold(order, hold) {
  if (!order) return hold;
  order.inventoryHold = {
    ...hold,
    updatedAt: new Date()
  };
  if (typeof order.markModified === 'function') {
    order.markModified('inventoryHold');
  }
  return order.inventoryHold;
}

function isTrackableVariant(variant) {
  return variant?.inventory?.trackInventory !== false;
}

function lineProductCode(line) {
  const fromVariant = normalizeProductCode(line?.variant?.productCode);
  if (fromVariant) return fromVariant;
  return normalizeProductCode(line?.productCode);
}

/**
 * Split checkout lines into inventory-API lines vs mongo-only lines.
 */
function splitCheckoutLines(lines) {
  const inventoryLines = [];
  const mongoLines = [];
  for (const line of lines || []) {
    const variant = line?.variant;
    if (!variant || !isTrackableVariant(variant)) continue;
    const qty = Number(line.quantity);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const productCode = lineProductCode(line);
    if (productCode) {
      inventoryLines.push({
        productCode,
        quantity: qty,
        product: line.product,
        variant
      });
    } else {
      mongoLines.push(line);
    }
  }
  // Merge duplicate productCodes for inventory API
  const merged = new Map();
  for (const row of inventoryLines) {
    const prev = merged.get(row.productCode);
    if (prev) prev.quantity += row.quantity;
    else merged.set(row.productCode, { productCode: row.productCode, quantity: row.quantity });
  }
  return {
    inventoryApiLines: [...merged.values()],
    mongoLines,
    // original trackable lines with codes (for mongo fallback of everything)
    allTrackableWithVariant: (lines || []).filter(
      (l) => l?.variant && isTrackableVariant(l.variant) && Number(l.quantity) > 0
    )
  };
}

async function reserveMongoCheckoutLines(lines, session) {
  const Product = require('../models/Product');
  for (const line of lines || []) {
    const variant = line?.variant;
    const product = line?.product;
    if (!product?._id || !variant?._id) {
      const err = new Error('Order line is missing product or variant information');
      err.statusCode = 500;
      err.code = 'ORDER_LINE_INVALID';
      throw err;
    }
    if (!isTrackableVariant(variant)) continue;

    const requestedQty = Number(line.quantity);
    if (!Number.isFinite(requestedQty) || requestedQty <= 0) {
      const err = new Error('Order line quantity must be greater than 0');
      err.statusCode = 400;
      err.code = 'ORDER_LINE_QUANTITY_INVALID';
      throw err;
    }

    let q = Product.updateOne(
      {
        _id: product._id,
        variants: {
          $elemMatch: {
            _id: variant._id,
            'inventory.trackInventory': true,
            'inventory.quantity': { $gte: requestedQty }
          }
        }
      },
      { $inc: { 'variants.$.inventory.quantity': -requestedQty } }
    );
    if (session) q = q.session(session);
    const reserveResult = await q;

    if (reserveResult.modifiedCount !== 1) {
      const err = new Error(
        `${product.name || 'Product'} stock changed during checkout. Please refresh your cart and try again.`
      );
      err.statusCode = 409;
      err.code = 'INSUFFICIENT_STOCK_RACE';
      err.details = {
        productId: String(product._id),
        variantId: String(variant._id),
        requestedQuantity: requestedQty
      };
      throw err;
    }
  }
}

function isDegradedReserveResult(result) {
  if (!result) return true;
  if (result.degraded) return true;
  if (DEGRADED_CODES.has(String(result.code || ''))) return true;
  if (result.httpStatus === 401 || result.httpStatus === 503) return true;
  if (result.httpStatus === 409 && result.code === 'ONLINE_WAREHOUSE_NOT_CONFIGURED') return true;
  // 5xx
  if (result.httpStatus >= 500) return true;
  return false;
}

/**
 * Reserve stock at checkout.
 * @returns {Promise<object>} inventoryHold snapshot
 */
async function reserveCheckoutStock({ orderId, storefront = 'ecomm', lines, session = null }) {
  const { inventoryApiLines, mongoLines, allTrackableWithVariant } = splitCheckoutLines(lines);

  if (!allTrackableWithVariant.length) {
    return emptyHold({ source: null, status: 'none', reason: 'no_trackable_lines' });
  }

  let inventoryReserved = false;
  let reservationId = null;
  let reason = null;

  if (isInventoryStockEnabled() && inventoryApiLines.length > 0) {
    try {
      const result = await reserveStock({
        orderId: String(orderId),
        storefront: storefront === 'wholesale' ? 'wholesale' : 'ecomm',
        lines: inventoryApiLines
      });

      if (result.success && (result.httpStatus === 200 || result.httpStatus === 201)) {
        inventoryReserved = true;
        reservationId =
          result.data?.reservation?.reservation_id ||
          result.data?.reservation_id ||
          null;
        reason = result.data?.idempotent ? 'idempotent_replay' : null;
      } else if (result.code === 'INSUFFICIENT_STOCK') {
        const err = new Error(
          result.message || 'Insufficient stock in inventory. Please refresh your cart.'
        );
        err.statusCode = 409;
        err.code = 'INSUFFICIENT_STOCK';
        err.details = result.details || null;
        throw err;
      } else if (
        result.code === 'ORDER_RESERVATION_CONFLICT' ||
        result.code === 'ORDER_RESERVATION_NOT_HELD'
      ) {
        const err = new Error(result.message || 'Inventory reservation conflict for this order');
        err.statusCode = 409;
        err.code = result.code;
        err.details = result.details || null;
        throw err;
      } else if (isDegradedReserveResult(result)) {
        reason = result.code || `HTTP_${result.httpStatus}`;
        logger.warn('[orderStockBridge] inventory reserve degraded — Mongo fallback', {
          orderId,
          code: reason
        });
      } else {
        reason = result.code || `HTTP_${result.httpStatus}`;
        logger.warn('[orderStockBridge] inventory reserve unexpected — Mongo fallback', {
          orderId,
          code: reason,
          httpStatus: result.httpStatus
        });
      }
    } catch (err) {
      if (err.statusCode && err.code === 'INSUFFICIENT_STOCK') throw err;
      if (err.statusCode && (err.code === 'ORDER_RESERVATION_CONFLICT' || err.code === 'ORDER_RESERVATION_NOT_HELD')) {
        throw err;
      }
      reason = err.code || 'NETWORK_ERROR';
      logger.warn('[orderStockBridge] inventory reserve threw — Mongo fallback', {
        orderId,
        message: err.message,
        code: reason
      });
    }
  } else if (!isInventoryStockEnabled()) {
    reason = 'inventory_disabled';
  } else {
    reason = 'no_product_codes';
  }

  let mongoReserved = false;

  if (inventoryReserved) {
    // Only mongo-cut lines that could not go to inventory (missing productCode)
    if (mongoLines.length > 0) {
      await reserveMongoCheckoutLines(mongoLines, session);
      mongoReserved = true;
    }
    return {
      source: mongoReserved ? 'hybrid' : 'inventory',
      status: 'held',
      reservationId,
      inventoryReserved: true,
      mongoReserved,
      reason,
      updatedAt: new Date()
    };
  }

  // Full Mongo fallback for all trackable lines
  await reserveMongoCheckoutLines(allTrackableWithVariant, session);
  mongoReserved = true;
  return {
    source: 'mongo',
    status: 'held',
    reservationId: null,
    inventoryReserved: false,
    mongoReserved: true,
    reason: reason || 'mongo_fallback',
    updatedAt: new Date()
  };
}

/**
 * Best-effort release of an inventory hold by orderId (e.g. createOrder rollback).
 */
async function releaseInventoryHoldByOrderId(orderId, meta = {}) {
  if (!orderId || !isInventoryStockEnabled()) return { ok: false, skipped: true };
  try {
    const result = await releaseStock({ orderId: String(orderId) });
    if (result.success || result.code === 'RESERVATION_NOT_FOUND') {
      return { ok: true, idempotent: Boolean(result.data?.idempotent), code: result.code };
    }
    if (result.code === 'ORDER_ALREADY_COMMITTED') {
      logger.error('[orderStockBridge] cannot release — already committed', {
        orderId,
        ...meta
      });
      return { ok: false, code: result.code };
    }
    logger.warn('[orderStockBridge] release by orderId unexpected', {
      orderId,
      code: result.code,
      httpStatus: result.httpStatus,
      ...meta
    });
    return { ok: false, code: result.code || null };
  } catch (err) {
    logger.error('[orderStockBridge] release by orderId failed', {
      orderId,
      message: err.message,
      ...meta
    });
    return { ok: false, error: err.message };
  }
}

/**
 * Release hold for a persisted order (cancel / fail / expiry).
 * Idempotent for already released/committed (committed → no stock return here).
 */
async function releaseOrderStockHold(order, session = null) {
  if (!order) return { ok: true, skipped: true };
  const hold = readHold(order);

  if (hold.status === 'released' || hold.status === 'none') {
    return { ok: true, skipped: true, reason: hold.status };
  }
  if (hold.status === 'committed') {
    // Sold stock is not returned on cancel-after-commit in Phase 2 (returns/RTO separate).
    logger.info('[orderStockBridge] release skipped — already committed', {
      orderId: order.orderId
    });
    return { ok: true, skipped: true, reason: 'committed' };
  }

  // Legacy orders without inventoryHold: treat as mongo
  const treatAsMongo = !hold.inventoryReserved && (hold.mongoReserved || !hold.source || hold.source === 'mongo');

  if (hold.inventoryReserved || hold.source === 'inventory' || hold.source === 'hybrid') {
    const rel = await releaseInventoryHoldByOrderId(order.orderId, { trigger: 'order_release' });
    if (!rel.ok && rel.code && rel.code !== 'RESERVATION_NOT_FOUND') {
      // Fail soft for cancel paths — log loudly; operator can reconcile
      logger.error('[orderStockBridge] inventory release incomplete', {
        orderId: order.orderId,
        code: rel.code
      });
    }
  }

  if (hold.mongoReserved || treatAsMongo || hold.source === 'mongo' || hold.source === 'hybrid') {
    if (hold.source === 'hybrid') {
      // Hybrid: inventory lines already released via API; mongo-only lines need productCode-less matching.
      // Safest: release only items missing productCode
      const mongoItems = (order.items || []).filter((it) => !normalizeProductCode(it.productCode));
      if (mongoItems.length) {
        await releaseReservedInventoryForLines(mongoItems, session);
      }
    } else if (hold.source === 'mongo' || treatAsMongo) {
      await releaseReservedInventoryForOrder(order, session);
    }
  }

  writeHold(order, {
    ...hold,
    status: 'released',
    reason: hold.reason
  });
  return { ok: true, skipped: false };
}

/**
 * Commit held inventory (payment capture / COD confirm).
 * Idempotent.
 */
async function commitOrderStockHold(order) {
  if (!order) return { ok: true, skipped: true };
  const hold = readHold(order);

  if (hold.status === 'committed') {
    return { ok: true, skipped: true, reason: 'already_committed' };
  }
  if (hold.status === 'released') {
    logger.warn('[orderStockBridge] commit skipped — hold already released', {
      orderId: order.orderId
    });
    return { ok: false, skipped: true, reason: 'released' };
  }
  if (hold.status !== 'held' && hold.status !== 'none') {
    return { ok: true, skipped: true, reason: hold.status };
  }

  // Mongo-only: qty already deducted at reserve — just mark committed
  if (!hold.inventoryReserved && (hold.source === 'mongo' || hold.mongoReserved || !hold.source)) {
    if (hold.status === 'held' || hold.mongoReserved) {
      writeHold(order, { ...hold, status: 'committed', source: hold.source || 'mongo' });
    }
    return { ok: true, skipped: false, reason: 'mongo_noop' };
  }

  if (hold.inventoryReserved || hold.source === 'inventory' || hold.source === 'hybrid') {
    if (!isInventoryStockEnabled()) {
      logger.error('[orderStockBridge] commit needed but inventory API disabled', {
        orderId: order.orderId
      });
      return { ok: false, reason: 'inventory_disabled' };
    }
    try {
      const result = await commitStock({ orderId: String(order.orderId) });
      if (result.success || result.data?.idempotent) {
        writeHold(order, {
          ...hold,
          status: 'committed',
          reservationId: hold.reservationId || result.data?.reservation?.reservation_id || null
        });
        return { ok: true, idempotent: Boolean(result.data?.idempotent) };
      }
      if (result.code === 'RESERVATION_NOT_FOUND') {
        logger.error('[orderStockBridge] commit reservation not found', { orderId: order.orderId });
        return { ok: false, code: result.code };
      }
      if (result.code === 'ORDER_ALREADY_RELEASED') {
        logger.error('[orderStockBridge] commit failed — already released', { orderId: order.orderId });
        writeHold(order, { ...hold, status: 'released', reason: 'commit_saw_released' });
        return { ok: false, code: result.code };
      }
      // STOCK_CONFLICT → retry once
      if (result.code === 'STOCK_CONFLICT') {
        const retry = await commitStock({ orderId: String(order.orderId) });
        if (retry.success || retry.data?.idempotent) {
          writeHold(order, { ...hold, status: 'committed' });
          return { ok: true, retried: true };
        }
      }
      logger.error('[orderStockBridge] commit unexpected', {
        orderId: order.orderId,
        code: result.code,
        httpStatus: result.httpStatus
      });
      return { ok: false, code: result.code || null };
    } catch (err) {
      logger.error('[orderStockBridge] commit threw', {
        orderId: order.orderId,
        message: err.message
      });
      return { ok: false, error: err.message };
    }
  }

  return { ok: true, skipped: true };
}

/**
 * Re-reserve after unpaid terminal path released stock but payment later captured.
 */
async function rereserveOrderStockHold(order, session = null) {
  if (!order?.orderId) return { ok: false };

  const hold = readHold(order);
  const lines = (order.items || []).map((it) => ({
    productCode: normalizeProductCode(it.productCode),
    quantity: Number(it.quantity) || 0
  })).filter((l) => l.productCode && l.quantity > 0);

  const preferInventory =
    isInventoryStockEnabled() &&
    lines.length > 0 &&
    (hold.source === 'inventory' || hold.source === 'hybrid' || hold.inventoryReserved || !hold.source);

  if (preferInventory) {
    try {
      const result = await reserveStock({
        orderId: String(order.orderId),
        storefront: order.storefront === 'wholesale' ? 'wholesale' : 'ecomm',
        lines
      });
      if (result.success && (result.httpStatus === 200 || result.httpStatus === 201)) {
        writeHold(order, {
          source: hold.source === 'hybrid' ? 'hybrid' : 'inventory',
          status: 'held',
          reservationId: result.data?.reservation?.reservation_id || null,
          inventoryReserved: true,
          mongoReserved: hold.source === 'hybrid' ? hold.mongoReserved : false,
          reason: 'payment_recovery_rereserve'
        });
        return { ok: true, source: 'inventory' };
      }
      if (result.code === 'INSUFFICIENT_STOCK') {
        logger.error('[orderStockBridge] re-reserve insufficient stock after payment', {
          orderId: order.orderId,
          details: result.details
        });
        return { ok: false, code: 'INSUFFICIENT_STOCK', details: result.details };
      }
      logger.warn('[orderStockBridge] re-reserve degraded — Mongo fallback', {
        orderId: order.orderId,
        code: result.code
      });
    } catch (err) {
      logger.warn('[orderStockBridge] re-reserve threw — Mongo fallback', {
        orderId: order.orderId,
        message: err.message
      });
    }
  }

  const mongoSummary = await reserveInventoryForOrder(order, session);
  writeHold(order, {
    source: 'mongo',
    status: 'held',
    reservationId: null,
    inventoryReserved: false,
    mongoReserved: true,
    reason: 'payment_recovery_mongo'
  });
  return {
    ok: mongoSummary.shortages.length === 0,
    source: 'mongo',
    summary: mongoSummary
  };
}

/**
 * Admin pending edit: only qty reductions. Inventory = full release + re-reserve new lines.
 */
async function syncHoldAfterPendingOrderEdit(order, session = null) {
  const hold = readHold(order);
  if (!order?.orderId) return { ok: true, skipped: true };

  if (hold.inventoryReserved || hold.source === 'inventory' || hold.source === 'hybrid') {
    if (hold.status === 'held') {
      await releaseInventoryHoldByOrderId(order.orderId, { trigger: 'admin_edit' });
    }
    const lines = (order.items || [])
      .map((it) => ({
        productCode: normalizeProductCode(it.productCode),
        quantity: Number(it.quantity) || 0
      }))
      .filter((l) => l.productCode && l.quantity > 0);

    if (lines.length === 0) {
      writeHold(order, emptyHold({ status: 'released', reason: 'admin_edit_empty' }));
      return { ok: true, releasedOnly: true };
    }

    if (isInventoryStockEnabled()) {
      const result = await reserveStock({
        orderId: String(order.orderId),
        storefront: order.storefront === 'wholesale' ? 'wholesale' : 'ecomm',
        lines
      });
      if (result.success && (result.httpStatus === 200 || result.httpStatus === 201)) {
        writeHold(order, {
          source: 'inventory',
          status: 'held',
          reservationId: result.data?.reservation?.reservation_id || null,
          inventoryReserved: true,
          mongoReserved: false,
          reason: 'admin_edit_rereserve'
        });
        return { ok: true, source: 'inventory' };
      }
      if (result.code === 'INSUFFICIENT_STOCK') {
        const err = new Error(result.message || 'Insufficient inventory stock for amended order');
        err.statusCode = 409;
        err.code = 'INSUFFICIENT_STOCK';
        err.details = result.details;
        throw err;
      }
      logger.warn('[orderStockBridge] admin edit re-reserve degraded', {
        orderId: order.orderId,
        code: result.code
      });
    }
  }

  // Mongo path: caller already released reduced lines via releaseReservedInventoryForLines
  writeHold(order, {
    ...hold,
    source: hold.source === 'inventory' ? 'mongo' : hold.source || 'mongo',
    status: 'held',
    inventoryReserved: false,
    mongoReserved: true,
    reason: 'admin_edit_mongo'
  });
  return { ok: true, source: 'mongo' };
}

/**
 * Build orderItems productCode from checkout lines (variant).
 */
function attachProductCodesToOrderItems(orderItems, lines) {
  const byVariant = new Map();
  for (const line of lines || []) {
    const vid = line?.variant?._id != null ? String(line.variant._id) : null;
    if (!vid) continue;
    byVariant.set(vid, normalizeProductCode(line.variant.productCode) || null);
  }
  return (orderItems || []).map((item) => {
    const vid = item.variantId != null ? String(item.variantId) : null;
    const code = (vid && byVariant.get(vid)) || normalizeProductCode(item.productCode) || null;
    return { ...item, productCode: code };
  });
}

module.exports = {
  emptyHold,
  readHold,
  writeHold,
  reserveCheckoutStock,
  releaseOrderStockHold,
  releaseInventoryHoldByOrderId,
  commitOrderStockHold,
  rereserveOrderStockHold,
  syncHoldAfterPendingOrderEdit,
  attachProductCodesToOrderItems,
  reserveMongoCheckoutLines,
  splitCheckoutLines
};
