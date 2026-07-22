/**
 * Overlay inventory-software available qty onto e-comm product variants (in memory).
 * Does NOT persist to Mongo. Missing codes / API degrade → keep Mongo qty.
 *
 * Variant-level only — never sums stocks across variants.
 *
 * Modes:
 * - replace (default): storefront — set inventory.quantity from inventory software
 * - annotate: admin — keep inventory.quantity (Mongo); set inventory.liveQuantity
 */

const logger = require('../utils/logger');
const {
  getStockBatch,
  isInventoryStockEnabled,
  normalizeProductCode
} = require('./externalInventory.service');
const { getVariantAvailability } = require('../utils/storefrontCatalog');

function asProductList(products) {
  if (!products) return [];
  return Array.isArray(products) ? products.filter(Boolean) : [products];
}

function collectProductCodes(products) {
  const codes = [];
  for (const product of asProductList(products)) {
    const variants = Array.isArray(product?.variants) ? product.variants : [];
    for (const variant of variants) {
      const code = normalizeProductCode(variant?.productCode);
      if (code) codes.push(code);
    }
  }
  return codes;
}

function ensureInventoryObject(variant) {
  if (!variant.inventory || typeof variant.inventory !== 'object') {
    variant.inventory = {
      quantity: 0,
      lowStockThreshold: 5,
      trackInventory: true
    };
  }
  return variant.inventory;
}

function recomputeVariantAvailability(variant, storefront) {
  if (!variant || storefront == null) return;
  // Only refresh if caller already exposed availability (decorated API products).
  if (variant.availability && typeof variant.availability === 'object') {
    if (variant.availability.ecomm != null || variant.availability.wholesale != null) {
      variant.availability = {
        ecomm: getVariantAvailability(variant, 'ecomm'),
        wholesale: getVariantAvailability(variant, 'wholesale')
      };
    } else {
      variant.availability = getVariantAvailability(variant, storefront);
    }
  }
}

function recomputeProductTotalStock(product) {
  if (!product || typeof product !== 'object') return;
  if (!Object.prototype.hasOwnProperty.call(product, 'totalStock')) return;
  const variants = Array.isArray(product.variants) ? product.variants : [];
  product.totalStock = variants.reduce((sum, v) => {
    const track = v?.inventory?.trackInventory !== false;
    if (!track) return sum;
    return sum + (Number(v?.inventory?.quantity) || 0);
  }, 0);
}

function recomputeProductLiveTotalStock(product) {
  if (!product || typeof product !== 'object') return;
  const variants = Array.isArray(product.variants) ? product.variants : [];
  let sum = 0;
  let any = false;
  for (const v of variants) {
    const live = v?.inventory?.liveQuantity;
    if (live == null || !Number.isFinite(Number(live))) continue;
    any = true;
    if (v?.inventory?.trackInventory === false) continue;
    sum += Number(live);
  }
  product.liveTotalStock = any ? sum : null;
}

/**
 * Apply batch result onto product variants (mutates in place).
 * @param {'replace'|'annotate'} [meta.mode='replace']
 * @returns {{ applied: number, fallback: number, degraded: boolean, reason: string|null }}
 */
function applyStockMapToProducts(products, stockMap, missingSet, meta = {}) {
  let applied = 0;
  let fallback = 0;
  const storefront = meta.storefront || null;
  const degraded = Boolean(meta.degraded);
  const mode = meta.mode === 'annotate' ? 'annotate' : 'replace';

  for (const product of asProductList(products)) {
    const variants = Array.isArray(product?.variants) ? product.variants : [];
    for (const variant of variants) {
      const code = normalizeProductCode(variant?.productCode);
      const inv = ensureInventoryObject(variant);

      if (!code) {
        inv.stockSource = 'mongo_fallback';
        if (mode === 'annotate') inv.liveQuantity = null;
        fallback += 1;
        if (mode === 'replace') recomputeVariantAvailability(variant, storefront);
        continue;
      }

      if (!degraded && stockMap.has(code)) {
        const liveQty = stockMap.get(code);
        if (mode === 'annotate') {
          // Admin: never overwrite Mongo quantity
          inv.liveQuantity = liveQty;
          inv.stockSource = 'inventory';
        } else {
          inv.quantity = liveQty;
          inv.stockSource = 'inventory';
          recomputeVariantAvailability(variant, storefront);
        }
        applied += 1;
      } else {
        inv.stockSource = degraded ? 'mongo_fallback_degraded' : 'mongo_fallback';
        if (mode === 'annotate') inv.liveQuantity = null;
        fallback += 1;
        if (mode === 'replace') recomputeVariantAvailability(variant, storefront);
      }
    }
    if (mode === 'replace') recomputeProductTotalStock(product);
    if (mode === 'annotate') recomputeProductLiveTotalStock(product);
  }

  return {
    applied,
    fallback,
    degraded,
    reason: meta.reason || null
  };
}

/**
 * Fetch inventory stock and overlay onto one or many products.
 * Always safe: never throws; on failure leaves Mongo quantities.
 *
 * @param {object|object[]} products plain objects or mongoose docs with .variants
 * @param {{ storefront?: string, logContext?: string, mode?: 'replace'|'annotate' }} [opts]
 */
async function overlayExternalStockOnProducts(products, opts = {}) {
  const list = asProductList(products);
  if (list.length === 0) {
    return { applied: 0, fallback: 0, degraded: false, reason: null };
  }

  const mode = opts.mode === 'annotate' ? 'annotate' : 'replace';

  if (!isInventoryStockEnabled()) {
    for (const product of list) {
      const variants = Array.isArray(product?.variants) ? product.variants : [];
      for (const variant of variants) {
        const inv = ensureInventoryObject(variant);
        inv.stockSource = 'mongo';
        if (mode === 'annotate') inv.liveQuantity = null;
      }
      if (mode === 'annotate') recomputeProductLiveTotalStock(product);
    }
    return { applied: 0, fallback: 0, degraded: false, reason: 'disabled' };
  }

  const codes = collectProductCodes(list);
  if (codes.length === 0) {
    if (mode === 'annotate') {
      for (const product of list) {
        const variants = Array.isArray(product?.variants) ? product.variants : [];
        for (const variant of variants) {
          ensureInventoryObject(variant).liveQuantity = null;
        }
        recomputeProductLiveTotalStock(product);
      }
    }
    return { applied: 0, fallback: 0, degraded: false, reason: null };
  }

  const batch = await getStockBatch(codes);
  const missingSet = new Set(batch.missing || []);

  if (batch.degraded) {
    logger.warn('[inventoryOverlay] degraded — using Mongo stock', {
      reason: batch.reason,
      codes: codes.length,
      context: opts.logContext || null,
      mode
    });
  } else if (missingSet.size > 0) {
    logger.warn('[inventoryOverlay] productCodes missing in inventory — Mongo fallback', {
      missing: [...missingSet].slice(0, 20),
      missingCount: missingSet.size,
      context: opts.logContext || null,
      mode
    });
  }

  return applyStockMapToProducts(list, batch.stock, missingSet, {
    storefront: opts.storefront,
    degraded: batch.degraded,
    reason: batch.reason,
    mode
  });
}

/**
 * Admin-safe: attach liveQuantity without changing Mongo quantity.
 */
async function annotateExternalStockOnProducts(products, opts = {}) {
  return overlayExternalStockOnProducts(products, { ...opts, mode: 'annotate' });
}

/**
 * Overlay a single product document/object. Returns the same reference.
 */
async function overlayExternalStockOnProduct(product, opts = {}) {
  if (!product) return product;
  await overlayExternalStockOnProducts(product, opts);
  return product;
}

module.exports = {
  overlayExternalStockOnProducts,
  overlayExternalStockOnProduct,
  annotateExternalStockOnProducts,
  collectProductCodes,
  applyStockMapToProducts
};
