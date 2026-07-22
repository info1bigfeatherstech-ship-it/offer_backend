const slugify = require('slugify');
const Product = require('../models/Product');

/**
 * Generate unique slug from product name
 */
const generateSlug = async (name, excludeId = null) => {
  const base = slugify(name, { lower: true, strict: true });
  let candidate = base;
  let suffix = 1;

  while (await Product.exists({ slug: candidate, ...(excludeId && { _id: { $ne: excludeId } }) })) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }

  return candidate;
};

/**
 * Canonical catalog SKU from productCode — same rule for single + bulk listing.
 * Examples: 1221-1 → SKU-1221-1 ; 2323 → SKU-2323
 *
 * @param {string} productCode already-normalized product code preferred
 * @returns {string}
 */
function buildSkuFromProductCode(productCode) {
  const code = String(productCode || '')
    .trim()
    .toUpperCase();
  if (!code) {
    const err = new Error('productCode is required to generate SKU');
    err.code = 'PRODUCT_CODE_REQUIRED_FOR_SKU';
    err.statusCode = 400;
    throw err;
  }
  // Idempotent if caller already passed a SKU-prefixed value
  if (code.startsWith('SKU-')) {
    if (code === 'SKU-' || code.length <= 4) {
      const err = new Error('Invalid SKU / productCode for SKU generation');
      err.code = 'INVALID_SKU_SOURCE';
      err.statusCode = 400;
      throw err;
    }
    return code;
  }
  return `SKU-${code}`;
}

/**
 * Resolve variant SKU: optional explicit CSV/manual sku (kept as-is when provided),
 * else productCode-derived `SKU-{productCode}`. Never generates random SKUs.
 *
 * @param {{ productCode: string, explicitSku?: string|null }} opts
 * @returns {string}
 */
function resolveVariantSku({ productCode, explicitSku } = {}) {
  const fromExplicit = String(explicitSku || '').trim();
  if (fromExplicit) {
    return fromExplicit;
  }
  return buildSkuFromProductCode(productCode);
}

/**
 * Ensure SKU is not already used on another variant (DB unique index also enforces).
 *
 * @param {string} sku
 * @param {{ excludeProductId?: import('mongoose').Types.ObjectId|string|null }} [opts]
 */
async function assertSkuAvailable(sku, opts = {}) {
  const normalized = String(sku || '').trim();
  if (!normalized) {
    const err = new Error('SKU is required');
    err.code = 'SKU_REQUIRED';
    err.statusCode = 400;
    throw err;
  }
  const filter = { 'variants.sku': normalized };
  if (opts.excludeProductId) {
    filter._id = { $ne: opts.excludeProductId };
  }
  const exists = await Product.exists(filter);
  if (exists) {
    const err = new Error(`SKU already exists: ${normalized}`);
    err.code = 'SKU_ALREADY_EXISTS';
    err.statusCode = 400;
    throw err;
  }
  return normalized;
}

/**
 * @deprecated Random SKUs are retired. Use {@link resolveVariantSku} / {@link buildSkuFromProductCode}.
 * Kept as a thin wrapper so any leftover callers still get productCode-based SKUs when passed a code.
 * @param {string} [productCode]
 */
const generateSku = async (productCode) => {
  if (!productCode) {
    const err = new Error(
      'generateSku requires productCode. Catalog SKUs are derived as SKU-{productCode}.'
    );
    err.code = 'PRODUCT_CODE_REQUIRED_FOR_SKU';
    err.statusCode = 400;
    throw err;
  }
  const sku = buildSkuFromProductCode(productCode);
  await assertSkuAvailable(sku);
  return sku;
};

/**
 * Validate product prices and MOQ
 */
const validateProductPrices = (price) => {
  if (!price.base || price.base <= 0) {
    throw new Error('Base price is required and must be greater than 0');
  }

  if (price.sale != null && price.sale >= price.base) {
    throw new Error('Sale price must be less than base price');
  }

  if (!price.wholesaleBase || price.wholesaleBase <= 0) {
    throw new Error('Wholesale base price is required and must be greater than 0');
  }

  if (price.wholesaleSale != null && price.wholesaleSale >= price.wholesaleBase) {
    throw new Error('Wholesale sale price must be less than wholesale base price');
  }

  if (!price.minimumOrderQuantity || price.minimumOrderQuantity < 1) {
    throw new Error('Minimum order quantity is required and must be at least 1');
  }
};

module.exports = {
  generateSlug,
  generateSku,
  buildSkuFromProductCode,
  resolveVariantSku,
  assertSkuAvailable,
  validateProductPrices
};
