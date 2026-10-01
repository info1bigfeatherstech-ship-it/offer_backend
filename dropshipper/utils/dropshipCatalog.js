'use strict';

/**
 * Dropship catalog helpers — isolated from ecomm/wholesale storefront filters.
 * Does not change existing storefrontKey / mongoCatalogListFilter behavior.
 */

const {
  CHANNEL_LIFECYCLE,
  hasDropshipPricingConfig
} = require('../../utils/storefrontCatalog');

function isValidLifecycle(value) {
  return CHANNEL_LIFECYCLE.includes(value);
}

function normalizeProductCode(value) {
  return String(value || '')
    .trim()
    .toUpperCase();
}

function parseDropshipBase(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Effective dropship visibility for a variant (pricing-gated).
 * Missing/unset visibility = not listed (draft), never inherit ecomm isActive.
 */
function effectiveDropshipVariantStatus(variant) {
  if (!hasDropshipPricingConfig(variant)) return 'draft';
  const direct = variant?.channelVisibility?.dropship;
  if (isValidLifecycle(direct)) return direct;
  return 'draft';
}

function isVariantDropshipListed(variant) {
  return effectiveDropshipVariantStatus(variant) === 'active';
}

function effectiveDropshipProductStatus(product) {
  const direct = product?.channelStatus?.dropship;
  if (isValidLifecycle(direct)) return direct;
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  if (variants.some((v) => isVariantDropshipListed(v))) return 'active';
  if (variants.some((v) => hasDropshipPricingConfig(v))) return 'draft';
  return 'draft';
}

function isProductDropshipListed(product) {
  return effectiveDropshipProductStatus(product) === 'active';
}

/**
 * Mongo filter: product has dropship channel active (or priced+visible variant).
 */
function mongoDropshipCatalogActiveFilter() {
  return {
    $or: [
      { 'channelStatus.dropship': 'active' },
      {
        variants: {
          $elemMatch: {
            dropship: true,
            'price.dropshipBase': { $gt: 0 },
            'channelVisibility.dropship': 'active'
          }
        }
      }
    ]
  };
}

function mongoDropshipHasVisibleVariantClause() {
  return {
    variants: {
      $elemMatch: {
        dropship: true,
        'price.dropshipBase': { $gt: 0 },
        'channelVisibility.dropship': 'active'
      }
    }
  };
}

function mongoDropshipCatalogListFilter() {
  return {
    $and: [mongoDropshipCatalogActiveFilter(), mongoDropshipHasVisibleVariantClause()]
  };
}

function serializeDropshipVariantSummary(variant) {
  const dropshipBase = Number(variant?.price?.dropshipBase);
  return {
    productCode: variant.productCode,
    sku: variant.sku,
    dropship: variant.dropship === true,
    dropshipBase: Number.isFinite(dropshipBase) && dropshipBase > 0 ? dropshipBase : null,
    dropshipEligible: hasDropshipPricingConfig(variant),
    channelVisibility: {
      ecomm: variant?.channelVisibility?.ecomm ?? null,
      wholesale: variant?.channelVisibility?.wholesale ?? null,
      dropship: variant?.channelVisibility?.dropship ?? null
    },
    dropshipListed: isVariantDropshipListed(variant),
    isActive: variant.isActive !== false
  };
}

module.exports = {
  normalizeProductCode,
  parseDropshipBase,
  hasDropshipPricingConfig,
  effectiveDropshipVariantStatus,
  isVariantDropshipListed,
  effectiveDropshipProductStatus,
  isProductDropshipListed,
  mongoDropshipCatalogActiveFilter,
  mongoDropshipHasVisibleVariantClause,
  mongoDropshipCatalogListFilter,
  serializeDropshipVariantSummary
};
