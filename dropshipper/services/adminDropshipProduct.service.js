'use strict';

/**
 * Admin dropship product mutations.
 * Touches only dropship fields on Product variants — ecomm/wholesale untouched.
 */

const Product = require('../../models/Product');
const {
  reconcileProductCatalogState,
  mergeVariantChannelVisibility
} = require('../../utils/storefrontCatalog');
const {
  normalizeProductCode,
  parseDropshipBase,
  hasDropshipPricingConfig,
  serializeDropshipVariantSummary,
  effectiveDropshipProductStatus,
  mongoDropshipCatalogListFilter
} = require('../utils/dropshipCatalog');

async function invalidateProductCaches(productSlug = null) {
  try {
    const cacheService = require('../../services/cache.service');
    const cacheConfig = require('../../config/cache.config');
    await cacheService.forget(`${cacheConfig.prefixes.PRODUCT}:*`);
    await cacheService.forget(`${cacheConfig.prefixes.SEARCH}:*`);
    console.log(`[dropshipper] Cache invalidated for product: ${productSlug || 'all'}`);
  } catch (err) {
    console.warn('[dropshipper] cache invalidate warning:', err.message);
  }
}

function findVariantIndex(doc, productCode) {
  const code = normalizeProductCode(productCode);
  return doc.variants.findIndex(
    (v) => normalizeProductCode(v.productCode) === code
  );
}

function ensureChannelVisibilityObject(variant) {
  if (!variant.channelVisibility || typeof variant.channelVisibility !== 'object') {
    variant.channelVisibility = {};
  }
  return variant.channelVisibility;
}

/**
 * Apply dropship price. Optionally enable listing in the same call.
 * @returns {{ doc, variant, previous }}
 */
async function setVariantDropshipPrice({
  slug,
  productCode,
  dropshipBase,
  enable = false
}) {
  const base = parseDropshipBase(dropshipBase);
  if (base == null) {
    const err = new Error('dropshipBase is required and must be a number greater than 0');
    err.statusCode = 400;
    err.code = 'DROPSHIP_PRICE_INVALID';
    throw err;
  }

  const doc = await Product.findOne({ slug: String(slug || '').trim() });
  if (!doc) {
    const err = new Error('Product not found');
    err.statusCode = 404;
    err.code = 'PRODUCT_NOT_FOUND';
    throw err;
  }

  const idx = findVariantIndex(doc, productCode);
  if (idx === -1) {
    const err = new Error('Variant not found for provided productCode');
    err.statusCode = 404;
    err.code = 'VARIANT_NOT_FOUND';
    throw err;
  }

  const variant = doc.variants[idx];
  const previous = serializeDropshipVariantSummary(variant);

  variant.dropship = true;
  if (!variant.price) variant.price = {};
  variant.price.dropshipBase = base;

  const vis = ensureChannelVisibilityObject(variant);
  if (enable === true) {
    variant.channelVisibility = mergeVariantChannelVisibility(variant, {
      dropship: 'active'
    });
  } else if (vis.dropship == null) {
    // Keep off until admin enables; do not inherit ecomm active.
    variant.channelVisibility = mergeVariantChannelVisibility(variant, {
      dropship: 'draft'
    });
  } else {
    // Re-merge so active stays only if still eligible after price set.
    variant.channelVisibility = mergeVariantChannelVisibility(variant, {
      dropship: vis.dropship
    });
  }

  doc.markModified('variants');
  reconcileProductCatalogState(doc);
  await doc.save({ validateBeforeSave: true });
  await invalidateProductCaches(doc.slug);

  return {
    doc,
    variant,
    previous,
    current: serializeDropshipVariantSummary(variant)
  };
}

/**
 * Enable dropship listing — requires existing dropship price (or pass dropshipBase).
 */
async function enableVariantDropship({ slug, productCode, dropshipBase }) {
  const doc = await Product.findOne({ slug: String(slug || '').trim() });
  if (!doc) {
    const err = new Error('Product not found');
    err.statusCode = 404;
    err.code = 'PRODUCT_NOT_FOUND';
    throw err;
  }

  const idx = findVariantIndex(doc, productCode);
  if (idx === -1) {
    const err = new Error('Variant not found for provided productCode');
    err.statusCode = 404;
    err.code = 'VARIANT_NOT_FOUND';
    throw err;
  }

  const variant = doc.variants[idx];
  const previous = serializeDropshipVariantSummary(variant);

  if (dropshipBase !== undefined && dropshipBase !== null && dropshipBase !== '') {
    const base = parseDropshipBase(dropshipBase);
    if (base == null) {
      const err = new Error('dropshipBase must be a number greater than 0');
      err.statusCode = 400;
      err.code = 'DROPSHIP_PRICE_INVALID';
      throw err;
    }
    variant.dropship = true;
    if (!variant.price) variant.price = {};
    variant.price.dropshipBase = base;
  } else {
    variant.dropship = true;
  }

  if (!hasDropshipPricingConfig(variant)) {
    const err = new Error(
      'Cannot enable dropship: set dropshipBase (>0) first, or pass dropshipBase in this request'
    );
    err.statusCode = 400;
    err.code = 'DROPSHIP_PRICE_REQUIRED';
    throw err;
  }

  variant.channelVisibility = mergeVariantChannelVisibility(variant, {
    dropship: 'active'
  });

  doc.markModified('variants');
  reconcileProductCatalogState(doc);
  await doc.save({ validateBeforeSave: true });
  await invalidateProductCaches(doc.slug);

  return {
    doc,
    variant,
    previous,
    current: serializeDropshipVariantSummary(variant)
  };
}

/**
 * Disable dropship listing (keeps price for later re-enable).
 */
async function disableVariantDropship({ slug, productCode, clearPrice = false }) {
  const doc = await Product.findOne({ slug: String(slug || '').trim() });
  if (!doc) {
    const err = new Error('Product not found');
    err.statusCode = 404;
    err.code = 'PRODUCT_NOT_FOUND';
    throw err;
  }

  const idx = findVariantIndex(doc, productCode);
  if (idx === -1) {
    const err = new Error('Variant not found for provided productCode');
    err.statusCode = 404;
    err.code = 'VARIANT_NOT_FOUND';
    throw err;
  }

  const variant = doc.variants[idx];
  const previous = serializeDropshipVariantSummary(variant);

  if (clearPrice === true) {
    variant.dropship = false;
    if (variant.price) {
      variant.price.dropshipBase = undefined;
    }
  }

  variant.channelVisibility = mergeVariantChannelVisibility(variant, {
    dropship: 'draft'
  });

  // If clearing price, flag off; otherwise keep dropship=true so price remains eligible.
  if (clearPrice !== true && variant.price?.dropshipBase > 0) {
    variant.dropship = true;
  }

  doc.markModified('variants');
  reconcileProductCatalogState(doc);
  await doc.save({ validateBeforeSave: true });
  await invalidateProductCaches(doc.slug);

  return {
    doc,
    variant,
    previous,
    current: serializeDropshipVariantSummary(variant)
  };
}

/**
 * Bulk enable by productCode (and optional slug).
 * Missing price → skip + report (does not fail whole request).
 *
 * @param {Array<{ productCode: string, slug?: string, dropshipBase?: number }>} items
 */
async function bulkEnableDropship(items) {
  if (!Array.isArray(items) || items.length === 0) {
    const err = new Error('items array is required and must not be empty');
    err.statusCode = 400;
    err.code = 'DROPSHIP_BULK_EMPTY';
    throw err;
  }

  const enabled = [];
  const skipped = [];
  const failed = [];

  for (const raw of items) {
    const productCode = normalizeProductCode(raw?.productCode);
    if (!productCode) {
      skipped.push({
        item: raw,
        reason: 'productCode missing',
        code: 'PRODUCT_CODE_REQUIRED'
      });
      continue;
    }

    try {
      let doc;
      if (raw?.slug) {
        doc = await Product.findOne({ slug: String(raw.slug).trim() });
      } else {
        doc = await Product.findOne({
          'variants.productCode': productCode
        });
      }

      if (!doc) {
        skipped.push({
          productCode,
          slug: raw?.slug || null,
          reason: 'Product not found',
          code: 'PRODUCT_NOT_FOUND'
        });
        continue;
      }

      const idx = findVariantIndex(doc, productCode);
      if (idx === -1) {
        skipped.push({
          productCode,
          slug: doc.slug,
          reason: 'Variant not found',
          code: 'VARIANT_NOT_FOUND'
        });
        continue;
      }

      const variant = doc.variants[idx];

      if (raw?.dropshipBase !== undefined && raw?.dropshipBase !== null && raw?.dropshipBase !== '') {
        const base = parseDropshipBase(raw.dropshipBase);
        if (base == null) {
          skipped.push({
            productCode,
            slug: doc.slug,
            reason: 'Invalid dropshipBase',
            code: 'DROPSHIP_PRICE_INVALID'
          });
          continue;
        }
        variant.dropship = true;
        if (!variant.price) variant.price = {};
        variant.price.dropshipBase = base;
      } else {
        variant.dropship = true;
      }

      if (!hasDropshipPricingConfig(variant)) {
        skipped.push({
          productCode,
          slug: doc.slug,
          reason: 'dropshipBase missing or not > 0 — set price first',
          code: 'DROPSHIP_PRICE_REQUIRED'
        });
        continue;
      }

      variant.channelVisibility = mergeVariantChannelVisibility(variant, {
        dropship: 'active'
      });
      doc.markModified('variants');
      reconcileProductCatalogState(doc);
      await doc.save({ validateBeforeSave: true });
      await invalidateProductCaches(doc.slug);

      enabled.push({
        slug: doc.slug,
        name: doc.name,
        variant: serializeDropshipVariantSummary(variant)
      });
    } catch (e) {
      failed.push({
        productCode,
        slug: raw?.slug || null,
        reason: e.message,
        code: e.code || 'DROPSHIP_ENABLE_FAILED'
      });
    }
  }

  return {
    enabledCount: enabled.length,
    skippedCount: skipped.length,
    failedCount: failed.length,
    enabled,
    skipped,
    failed
  };
}

/**
 * Bulk set dropship price (optionally enable each).
 * @param {Array<{ productCode: string, slug?: string, dropshipBase: number, enable?: boolean }>} items
 */
async function bulkSetDropshipPrice(items) {
  if (!Array.isArray(items) || items.length === 0) {
    const err = new Error('items array is required and must not be empty');
    err.statusCode = 400;
    err.code = 'DROPSHIP_BULK_EMPTY';
    throw err;
  }

  const updated = [];
  const skipped = [];
  const failed = [];

  for (const raw of items) {
    const productCode = normalizeProductCode(raw?.productCode);
    const base = parseDropshipBase(raw?.dropshipBase);

    if (!productCode) {
      skipped.push({
        item: raw,
        reason: 'productCode missing',
        code: 'PRODUCT_CODE_REQUIRED'
      });
      continue;
    }
    if (base == null) {
      skipped.push({
        productCode,
        reason: 'dropshipBase missing or invalid',
        code: 'DROPSHIP_PRICE_INVALID'
      });
      continue;
    }

    try {
      let doc;
      if (raw?.slug) {
        doc = await Product.findOne({ slug: String(raw.slug).trim() });
      } else {
        doc = await Product.findOne({ 'variants.productCode': productCode });
      }

      if (!doc) {
        skipped.push({
          productCode,
          slug: raw?.slug || null,
          reason: 'Product not found',
          code: 'PRODUCT_NOT_FOUND'
        });
        continue;
      }

      const idx = findVariantIndex(doc, productCode);
      if (idx === -1) {
        skipped.push({
          productCode,
          slug: doc.slug,
          reason: 'Variant not found',
          code: 'VARIANT_NOT_FOUND'
        });
        continue;
      }

      const variant = doc.variants[idx];
      variant.dropship = true;
      if (!variant.price) variant.price = {};
      variant.price.dropshipBase = base;

      const enable = raw?.enable === true;
      const vis = ensureChannelVisibilityObject(variant);
      if (enable) {
        variant.channelVisibility = mergeVariantChannelVisibility(variant, {
          dropship: 'active'
        });
      } else if (vis.dropship == null) {
        variant.channelVisibility = mergeVariantChannelVisibility(variant, {
          dropship: 'draft'
        });
      } else {
        variant.channelVisibility = mergeVariantChannelVisibility(variant, {
          dropship: vis.dropship
        });
      }

      doc.markModified('variants');
      reconcileProductCatalogState(doc);
      await doc.save({ validateBeforeSave: true });
      await invalidateProductCaches(doc.slug);

      updated.push({
        slug: doc.slug,
        name: doc.name,
        variant: serializeDropshipVariantSummary(variant)
      });
    } catch (e) {
      failed.push({
        productCode,
        slug: raw?.slug || null,
        reason: e.message,
        code: e.code || 'DROPSHIP_PRICE_SET_FAILED'
      });
    }
  }

  return {
    updatedCount: updated.length,
    skippedCount: skipped.length,
    failedCount: failed.length,
    updated,
    skipped,
    failed
  };
}

/**
 * Admin list: products with any dropship-priced or dropship-listed variants.
 */
async function listDropshipProducts({ page = 1, limit = 20, listedOnly = false, q } = {}) {
  const pageNumber = Math.max(1, Number(page) || 1);
  const limitNumber = Math.min(100, Math.max(1, Number(limit) || 20));
  const skip = (pageNumber - 1) * limitNumber;

  const andClauses = [];

  if (listedOnly) {
    andClauses.push(...mongoDropshipCatalogListFilter().$and);
  } else {
    andClauses.push({
      variants: {
        $elemMatch: {
          $or: [
            { dropship: true },
            { 'price.dropshipBase': { $gt: 0 } },
            { 'channelVisibility.dropship': { $in: ['active', 'draft', 'archived'] } }
          ]
        }
      }
    });
  }

  if (q && String(q).trim()) {
    const term = String(q).trim();
    const rx = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    andClauses.push({
      $or: [
        { name: rx },
        { slug: rx },
        { 'variants.productCode': rx },
        { 'variants.sku': rx }
      ]
    });
  }

  const filter = andClauses.length === 1 ? andClauses[0] : { $and: andClauses };

  const [total, docs] = await Promise.all([
    Product.countDocuments(filter),
    Product.find(filter)
      .select(
        'name slug status channelStatus variants.productCode variants.sku variants.dropship variants.price variants.channelVisibility variants.isActive'
      )
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limitNumber)
      .lean()
  ]);

  const products = docs.map((doc) => ({
    slug: doc.slug,
    name: doc.name,
    status: doc.status,
    channelStatus: doc.channelStatus || null,
    dropshipStatus: effectiveDropshipProductStatus(doc),
    variants: (doc.variants || []).map(serializeDropshipVariantSummary)
  }));

  return {
    products,
    pagination: {
      page: pageNumber,
      limit: limitNumber,
      total,
      totalPages: Math.ceil(total / limitNumber) || 0
    }
  };
}

async function getDropshipProductBySlug(slug) {
  const doc = await Product.findOne({ slug: String(slug || '').trim() })
    .select('name slug status channelStatus variants')
    .lean();
  if (!doc) {
    const err = new Error('Product not found');
    err.statusCode = 404;
    err.code = 'PRODUCT_NOT_FOUND';
    throw err;
  }
  return {
    slug: doc.slug,
    name: doc.name,
    status: doc.status,
    channelStatus: doc.channelStatus || null,
    dropshipStatus: effectiveDropshipProductStatus(doc),
    variants: (doc.variants || []).map(serializeDropshipVariantSummary)
  };
}

module.exports = {
  setVariantDropshipPrice,
  enableVariantDropship,
  disableVariantDropship,
  bulkEnableDropship,
  bulkSetDropshipPrice,
  listDropshipProducts,
  getDropshipProductBySlug
};
