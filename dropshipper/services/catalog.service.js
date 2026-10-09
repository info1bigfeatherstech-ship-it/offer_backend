'use strict';

/**
 * Dropshipper catalog read APIs.
 * Isolated from ecomm/wholesale catalog controllers.
 */

const Product = require('../../models/Product');
const {
  mongoDropshipCatalogListFilter,
  normalizeProductCode,
  serializeDropshipperProductCard,
  serializeDropshipperProductDetail,
  serializeDropshipperVariant,
  isVariantDropshipListed
} = require('../utils/dropshipperCatalogSerialize');

const LIST_SELECT =
  'name slug title description brand category variants.productCode variants.sku variants.title variants.description variants.attributes variants.images variants.dropship variants.price.dropshipBase variants.price.base variants.price.sale variants.channelVisibility variants.inventory variants.isActive hsnCode gstRate isFragile channelStatus.dropship updatedAt';

const DETAIL_SELECT =
  'name slug title description brand category shipping variants hsnCode gstRate isFragile channelStatus.dropship updatedAt createdAt';

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildListFilter({ q, categoryId, inStockOnly } = {}) {
  // Start from product-level dropship active filter only; variant visibility
  // is a single $elemMatch so inStockOnly can merge into the same clause.
  const {
    mongoDropshipCatalogActiveFilter
  } = require('../utils/dropshipCatalog');

  const variantMatch = {
    dropship: true,
    'price.dropshipBase': { $gt: 0 },
    'channelVisibility.dropship': 'active'
  };
  if (inStockOnly === true) {
    variantMatch.$or = [
      { 'inventory.trackInventory': false },
      { 'inventory.quantity': { $gt: 0 } }
    ];
  }

  const andClauses = [
    mongoDropshipCatalogActiveFilter(),
    { variants: { $elemMatch: variantMatch } },
    // Prefer non-archived products; still allow if dropship channel is active
    {
      $or: [{ status: { $ne: 'archived' } }, { 'channelStatus.dropship': 'active' }]
    }
  ];

  if (categoryId) {
    andClauses.push({ category: categoryId });
  }

  if (q && String(q).trim()) {
    const term = String(q).trim();
    const rx = new RegExp(escapeRegex(term), 'i');
    andClauses.push({
      $or: [
        { name: rx },
        { title: rx },
        { slug: rx },
        { brand: rx },
        { 'variants.productCode': rx },
        { 'variants.sku': rx }
      ]
    });
  }

  return { $and: andClauses };
}

/**
 * GET catalog list
 */
async function listCatalogProducts({
  page = 1,
  limit = 20,
  q,
  categoryId,
  inStockOnly = false,
  sort = 'newest'
} = {}) {
  const pageNumber = Math.max(1, Number(page) || 1);
  const limitNumber = Math.min(100, Math.max(1, Number(limit) || 20));
  const skip = (pageNumber - 1) * limitNumber;

  const filter = buildListFilter({ q, categoryId, inStockOnly });

  let sortSpec = { updatedAt: -1 };
  if (sort === 'name_asc') sortSpec = { name: 1 };
  else if (sort === 'price_asc') sortSpec = { 'variants.price.dropshipBase': 1 };
  else if (sort === 'price_desc') sortSpec = { 'variants.price.dropshipBase': -1 };
  else sortSpec = { updatedAt: -1 };

  const [total, docs] = await Promise.all([
    Product.countDocuments(filter),
    Product.find(filter)
      .select(LIST_SELECT)
      .populate('category', 'name slug')
      .sort(sortSpec)
      .skip(skip)
      .limit(limitNumber)
      .lean()
  ]);

  const products = docs
    .map((doc) => serializeDropshipperProductCard(doc))
    .filter(Boolean);

  // In-memory stock filter on serialized variants if needed (elemMatch already applied)
  return {
    products,
    pagination: {
      page: pageNumber,
      limit: limitNumber,
      total,
      totalPages: Math.ceil(total / limitNumber) || 0,
      returned: products.length
    }
  };
}

/**
 * GET product by slug — only dropship-listed variants
 */
async function getCatalogProductBySlug(slug) {
  const cleanSlug = String(slug || '')
    .trim()
    .toLowerCase();
  if (!cleanSlug) {
    const err = new Error('Product slug is required');
    err.statusCode = 400;
    err.code = 'SLUG_REQUIRED';
    throw err;
  }

  const doc = await Product.findOne({ slug: cleanSlug })
    .select(DETAIL_SELECT)
    .populate('category', 'name slug')
    .lean();

  if (!doc) {
    const err = new Error('Product not found');
    err.statusCode = 404;
    err.code = 'PRODUCT_NOT_FOUND';
    throw err;
  }

  const detail = serializeDropshipperProductDetail(doc);
  if (!detail) {
    const err = new Error('No dropship-listed variants for this product');
    err.statusCode = 404;
    err.code = 'DROPSHIP_NOT_LISTED';
    throw err;
  }

  return detail;
}

/**
 * GET single variant by productCode
 */
async function getCatalogVariantByProductCode(productCode) {
  const code = normalizeProductCode(productCode);
  if (!code) {
    const err = new Error('productCode is required');
    err.statusCode = 400;
    err.code = 'PRODUCT_CODE_REQUIRED';
    throw err;
  }

  const doc = await Product.findOne({ 'variants.productCode': code })
    .select(DETAIL_SELECT)
    .populate('category', 'name slug')
    .lean();

  if (!doc) {
    const err = new Error('Variant not found');
    err.statusCode = 404;
    err.code = 'VARIANT_NOT_FOUND';
    throw err;
  }

  const variant = (doc.variants || []).find(
    (v) => normalizeProductCode(v.productCode) === code
  );
  if (!variant || !isVariantDropshipListed(variant)) {
    const err = new Error('Variant is not available for dropshipping');
    err.statusCode = 404;
    err.code = 'DROPSHIP_NOT_LISTED';
    throw err;
  }

  const serialized = serializeDropshipperVariant(variant, doc, { detailed: true });
  if (!serialized) {
    const err = new Error('Variant is not available for dropshipping');
    err.statusCode = 404;
    err.code = 'DROPSHIP_NOT_LISTED';
    throw err;
  }

  return {
    product: {
      id: String(doc._id),
      slug: doc.slug,
      name: doc.name,
      title: doc.title || doc.name,
      brand: doc.brand || null
    },
    variant: serialized
  };
}

/**
 * Download-ready pack (JSON) for FE to generate ZIP/PDF/images
 */
async function getVariantDownloadPack(productCode) {
  const result = await getCatalogVariantByProductCode(productCode);
  const pack = result.variant.downloadPack;
  if (!pack) {
    const err = new Error('Download pack unavailable');
    err.statusCode = 404;
    err.code = 'DOWNLOAD_PACK_UNAVAILABLE';
    throw err;
  }

  return {
    product: result.product,
    productCode: result.variant.productCode,
    generatedAt: new Date().toISOString(),
    pack
  };
}

module.exports = {
  listCatalogProducts,
  getCatalogProductBySlug,
  getCatalogVariantByProductCode,
  getVariantDownloadPack
};
