'use strict';

/**
 * Dropshipper-facing catalog serializers.
 * Never expose ecomm/wholesale as the payable price.
 */

const {
  isVariantDropshipListed,
  hasDropshipPricingConfig,
  mongoDropshipCatalogListFilter,
  normalizeProductCode
} = require('./dropshipCatalog');

const { resolveVariantShipping } = require('../../utils/variantCatalogFields');

function safeNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pickImages(variant, product) {
  const variantImages = Array.isArray(variant?.images) ? variant.images : [];
  if (variantImages.length) {
    return variantImages
      .slice()
      .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))
      .map((img, idx) => ({
        url: img.url,
        altText: img.altText || '',
        order: img.order != null ? img.order : idx,
        publicId: img.publicId || null
      }))
      .filter((img) => Boolean(img.url));
  }
  // Fallback: no product-level gallery on Product model beyond variants — return empty
  return [];
}

function stockMeta(variant) {
  const track = variant?.inventory?.trackInventory !== false;
  const qty = safeNumber(variant?.inventory?.quantity, 0) ?? 0;
  const low = safeNumber(variant?.inventory?.lowStockThreshold, 5) ?? 5;
  if (!track) {
    return { trackInventory: false, quantity: null, stockStatus: 'in_stock' };
  }
  if (qty <= 0) {
    return { trackInventory: true, quantity: qty, stockStatus: 'out_of_stock' };
  }
  if (qty <= low) {
    return { trackInventory: true, quantity: qty, stockStatus: 'low_stock' };
  }
  return { trackInventory: true, quantity: qty, stockStatus: 'in_stock' };
}

/**
 * Suggested retail from ecomm prices — display/margin hint ONLY.
 * Must never be used as dropship checkout price.
 */
function suggestedRetailFromVariant(variant) {
  const sale = safeNumber(variant?.price?.sale, null);
  const base = safeNumber(variant?.price?.base, null);
  if (sale != null && sale > 0 && (base == null || sale < base)) return sale;
  if (base != null && base > 0) return base;
  return null;
}

function serializeDropshipperVariant(variant, product, { detailed = false } = {}) {
  if (!isVariantDropshipListed(variant)) return null;

  const dropshipPrice = safeNumber(variant?.price?.dropshipBase, null);
  if (dropshipPrice == null || dropshipPrice <= 0) return null;

  const images = pickImages(variant, product);
  const stock = stockMeta(variant);
  const title = String(variant.title || product.title || product.name || '').trim();
  const description = String(
    variant.description != null && variant.description !== ''
      ? variant.description
      : product.description || ''
  );

  const base = {
    id: String(variant._id || ''),
    productId: String(product._id || ''),
    productSlug: product.slug,
    productName: product.name,
    productCode: variant.productCode,
    sku: variant.sku || null,
    title,
    /** Payable price for dropshipper → OWB */
    dropshipPrice,
    /**
     * Optional market hint from ecomm (NOT payable).
     * FE may show margin estimate only.
     */
    suggestedRetailPrice: suggestedRetailFromVariant(variant),
    currency: 'INR',
    attributes: Array.isArray(variant.attributes)
      ? variant.attributes
          .filter((a) => a && a.key && a.value)
          .map((a) => ({ key: a.key, value: a.value }))
      : [],
    thumbnail: images[0]?.url || null,
    images: images.map((img) => img.url),
    ...stock,
    category: product.category
      ? {
          id: String(product.category._id || product.category),
          name: product.category.name || null,
          slug: product.category.slug || null
        }
      : null,
    brand: product.brand || null
  };

  if (!detailed) return base;

  const shipping = resolveVariantShipping(variant, product) || {};
  return {
    ...base,
    description,
    imageDetails: images,
    shipping: {
      weight: safeNumber(shipping.weight, null),
      dimensions: {
        length: safeNumber(shipping.dimensions?.length, null),
        width: safeNumber(shipping.dimensions?.width, null),
        height: safeNumber(shipping.dimensions?.height, null)
      }
    },
    hsnCode: product.hsnCode || null,
    gstRate: product.gstRate != null ? product.gstRate : null,
    isFragile: product.isFragile === true,
    downloadPack: {
      productName: product.name,
      productCode: variant.productCode,
      title,
      description,
      dropshipPrice,
      suggestedRetailPrice: base.suggestedRetailPrice,
      attributes: base.attributes,
      images: images.map((img) => ({ url: img.url, altText: img.altText })),
      shipping: {
        weightKg: safeNumber(shipping.weight, null),
        lengthCm: safeNumber(shipping.dimensions?.length, null),
        widthCm: safeNumber(shipping.dimensions?.width, null),
        heightCm: safeNumber(shipping.dimensions?.height, null)
      }
    }
  };
}

function serializeDropshipperProductCard(product) {
  const variants = (product.variants || [])
    .map((v) => serializeDropshipperVariant(v, product, { detailed: false }))
    .filter(Boolean);

  if (!variants.length) return null;

  const minPrice = Math.min(...variants.map((v) => v.dropshipPrice));
  const maxPrice = Math.max(...variants.map((v) => v.dropshipPrice));

  return {
    id: String(product._id),
    slug: product.slug,
    name: product.name,
    title: product.title || product.name,
    brand: product.brand || null,
    category: product.category
      ? {
          id: String(product.category._id || product.category),
          name: product.category.name || null,
          slug: product.category.slug || null
        }
      : null,
    thumbnail: variants[0]?.thumbnail || null,
    dropshipPriceMin: minPrice,
    dropshipPriceMax: maxPrice,
    variantCount: variants.length,
    variants
  };
}

function serializeDropshipperProductDetail(product) {
  const variants = (product.variants || [])
    .map((v) => serializeDropshipperVariant(v, product, { detailed: true }))
    .filter(Boolean);

  if (!variants.length) return null;

  return {
    id: String(product._id),
    slug: product.slug,
    name: product.name,
    title: product.title || product.name,
    description: product.description || '',
    brand: product.brand || null,
    category: product.category
      ? {
          id: String(product.category._id || product.category),
          name: product.category.name || null,
          slug: product.category.slug || null
        }
      : null,
    hsnCode: product.hsnCode || null,
    gstRate: product.gstRate != null ? product.gstRate : null,
    isFragile: product.isFragile === true,
    variants
  };
}

module.exports = {
  mongoDropshipCatalogListFilter,
  normalizeProductCode,
  isVariantDropshipListed,
  hasDropshipPricingConfig,
  serializeDropshipperVariant,
  serializeDropshipperProductCard,
  serializeDropshipperProductDetail
};
