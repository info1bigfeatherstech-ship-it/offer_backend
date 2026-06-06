const CHANNEL_LIFECYCLE = ['draft', 'active', 'archived'];

const STOREFRONT_KEYS = {
  ecomm: 'ecomm',
  wholesale: 'wholesale'
};

function isValidLifecycle(value) {
  return CHANNEL_LIFECYCLE.includes(value);
}

function normalizeLifecycle(value, fallback) {
  if (isValidLifecycle(value)) return value;
  return fallback;
}

/**
 * Default channel map from legacy single product status (create / migration).
 * @param {string} status draft|active|archived
 * @param {object|null|undefined} body optional partial { ecomm?, wholesale? }
 */
function deriveProductChannelStatusFromLegacy(status, body) {
  const fb = normalizeLifecycle(status, 'draft');
  const out = { ecomm: fb, wholesale: fb };
  if (body && typeof body === 'object') {
    if (body.ecomm != null) out.ecomm = normalizeLifecycle(body.ecomm, fb);
    if (body.wholesale != null) {
      out.wholesale = normalizeLifecycle(body.wholesale, fb);
    }
  }
  return out;
}

/**
 * @param {boolean} isActive legacy variant flag
 * @param {object|null|undefined} body optional partial channel visibility
 */
function deriveVariantChannelVisibilityFromLegacy(isActive, body, options = {}) {
  const fb = isActive ? 'active' : 'draft';
  const isWholesaleEligible = options.isWholesaleEligible !== false;
  const out = { ecomm: fb, wholesale: isWholesaleEligible ? fb : 'draft' };
  if (body && typeof body === 'object') {
    if (body.ecomm != null) out.ecomm = normalizeLifecycle(body.ecomm, fb);
    if (body.wholesale != null) {
      const requested = normalizeLifecycle(body.wholesale, fb);
      out.wholesale = isWholesaleEligible ? requested : 'draft';
    }
  }
  return out;
}

function storefrontKey(storefront) {
  return storefront === STOREFRONT_KEYS.wholesale ? 'wholesale' : 'ecomm';
}

function hasWholesalePricingConfig(variant) {
  const wholesaleBase = Number(variant?.price?.wholesaleBase);
  return Boolean(variant?.wholesale === true && Number.isFinite(wholesaleBase) && wholesaleBase > 0);
}

function _toSafeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function getVariantAvailability(variant, storefront) {
  const sf = storefrontKey(storefront);
  const listed = isVariantListedOnStorefront(variant, sf);
  const trackInventory = variant?.inventory?.trackInventory !== false;
  const quantity = _toSafeNumber(variant?.inventory?.quantity, 0);
  const minimumOrderQuantity = Math.max(1, _toSafeNumber(variant?.minimumOrderQuantity, 1));

  if (!listed) {
    return {
      storefront: sf,
      listed: false,
      purchasable: false,
      status: 'NOT_LISTED',
      quantity,
      requiredQuantity: sf === 'wholesale' ? minimumOrderQuantity : 1
    };
  }

  if (!trackInventory) {
    return {
      storefront: sf,
      listed: true,
      purchasable: true,
      status: 'IN_STOCK',
      quantity: null,
      requiredQuantity: sf === 'wholesale' ? minimumOrderQuantity : 1
    };
  }

  if (quantity <= 0) {
    return {
      storefront: sf,
      listed: true,
      purchasable: false,
      status: 'OUT_OF_STOCK',
      quantity,
      requiredQuantity: sf === 'wholesale' ? minimumOrderQuantity : 1
    };
  }

  if (sf === 'wholesale' && quantity < minimumOrderQuantity) {
    return {
      storefront: sf,
      listed: true,
      purchasable: false,
      status: 'MOQ_UNMET',
      quantity,
      requiredQuantity: minimumOrderQuantity
    };
  }

  return {
    storefront: sf,
    listed: true,
    purchasable: true,
    status: 'IN_STOCK',
    quantity,
    requiredQuantity: sf === 'wholesale' ? minimumOrderQuantity : 1
  };
}

function getVariantAvailabilityByStorefront(variant) {
  return {
    ecomm: getVariantAvailability(variant, 'ecomm'),
    wholesale: getVariantAvailability(variant, 'wholesale')
  };
}

/**
 * Effective lifecycle for a product on one storefront (new fields with fallback to legacy status).
 * @param {object} product plain or mongoose doc
 * @param {'ecomm'|'wholesale'} storefront
 */
function effectiveProductChannelStatus(product, storefront) {
  const key = storefrontKey(storefront);
  const ch = product.channelStatus;
  const direct = ch && typeof ch === 'object' ? ch[key] : undefined;
  if (isValidLifecycle(direct)) return direct;
  return normalizeLifecycle(product.status, 'draft');
}

/**
 * Effective lifecycle for a variant on one storefront.
 * @param {object} variant
 * @param {'ecomm'|'wholesale'} storefront
 */
function effectiveVariantChannelStatus(variant, storefront) {
  if (storefrontKey(storefront) === 'wholesale' && !hasWholesalePricingConfig(variant)) {
    return 'draft';
  }
  const key = storefrontKey(storefront);
  const vis = variant.channelVisibility;
  const direct = vis && typeof vis === 'object' ? vis[key] : undefined;
  if (isValidLifecycle(direct)) return direct;
  return variant.isActive === false ? 'draft' : 'active';
}

function isProductListedOnStorefront(product, storefront) {
  return effectiveProductChannelStatus(product, storefront) === 'active';
}

function isVariantListedOnStorefront(variant, storefront) {
  return effectiveVariantChannelStatus(variant, storefront) === 'active';
}

/**
 * Mongo filter: product is catalog-active on the given storefront.
 * Uses per-channel status when set; otherwise falls back to legacy `status === 'active'`.
 * @param {'ecomm'|'wholesale'} storefront
 */
function mongoProductCatalogActiveFilter(storefront) {
  const key = storefrontKey(storefront);
  const channelField = `channelStatus.${key}`;
  return {
    $or: [
      { [channelField]: 'active' },
      {
        $and: [
          {
            $or: [
              { channelStatus: { $exists: false } },
              { [channelField]: { $exists: false } },
              { [channelField]: null }
            ]
          },
          { status: 'active' }
        ]
      }
    ]
  };
}

/**
 * At least one variant is purchasable/listable on this storefront (with legacy fallback).
 * @param {'ecomm'|'wholesale'} storefront
 */
function mongoHasVisibleVariantClause(storefront) {
  const key = storefrontKey(storefront);
  const vf = `channelVisibility.${key}`;
  const visibilityRule = {
    $or: [
      { [vf]: 'active' },
      {
        $and: [
          {
            $or: [
              { channelVisibility: { $exists: false } },
              { [vf]: { $exists: false } },
              { [vf]: null }
            ]
          },
          { isActive: { $ne: false } }
        ]
      }
    ]
  };

  const wholesaleEligibility =
    key === 'wholesale'
      ? {
          wholesale: true,
          'price.wholesaleBase': { $gt: 0 }
        }
      : {};

  return {
    variants: {
      $elemMatch: {
        ...visibilityRule,
        ...wholesaleEligibility
      }
    }
  };
}

/**
 * Combined catalog match for list/count/search (product + variant visibility).
 */
function mongoCatalogListFilter(storefront) {
  return {
    $and: [
      mongoProductCatalogActiveFilter(storefront),
      mongoHasVisibleVariantClause(storefront)
    ]
  };
}

/**
 * AND-merge extra clause(s) with the standard catalog list filter.
 * @param {'ecomm'|'wholesale'} storefront
 * @param {...object} clauses each must be a non-null plain filter object
 */
function mongoCatalogAnd(storefront, ...clauses) {
  const list = [...mongoCatalogListFilter(storefront).$and];
  for (const c of clauses) {
    if (c != null && typeof c === 'object' && Object.keys(c).length) {
      list.push(c);
    }
  }
  return { $and: list };
}

/**
 * Merge partial channelStatus from admin API onto existing + legacy fallback.
 * @param {object} doc mongoose product doc
 * @param {object} parsed partial { ecomm?, wholesale? }
 */
function mergeProductChannelStatus(doc, parsed) {
  const fb = normalizeLifecycle(doc.status, 'draft');
  const cur = (doc.channelStatus && doc.channelStatus.toObject
    ? doc.channelStatus.toObject()
    : doc.channelStatus) || {};
  return {
    ecomm: isValidLifecycle(parsed.ecomm)
      ? parsed.ecomm
      : cur.ecomm != null
        ? cur.ecomm
        : fb,
    wholesale: isValidLifecycle(parsed.wholesale)
      ? parsed.wholesale
      : cur.wholesale != null
        ? cur.wholesale
        : fb
  };
}

/**
 * Merge partial variant channelVisibility.
 * @param {object} variant mongoose subdoc
 * @param {object} parsed partial { ecomm?, wholesale? }
 */
function mergeVariantChannelVisibility(variant, parsed) {
  const fb = variant.isActive === false ? 'draft' : 'active';
  const wholesaleEligible = hasWholesalePricingConfig(variant);
  const cur = variant.channelVisibility || {};
  return {
    ecomm: isValidLifecycle(parsed.ecomm)
      ? parsed.ecomm
      : cur.ecomm != null
        ? cur.ecomm
        : fb,
    wholesale: isValidLifecycle(parsed.wholesale)
      ? (wholesaleEligible ? parsed.wholesale : 'draft')
      : cur.wholesale != null
        ? cur.wholesale
        : (wholesaleEligible ? fb : 'draft')
  };
}

/**
 * Filter variants for storefront listing; preserves order.
 */
function filterVariantsForStorefront(variants, storefront) {
  if (!Array.isArray(variants)) return [];
  return variants.filter((v) => isVariantListedOnStorefront(v, storefront));
}

/**
 * Derive product-level channelStatus from variant visibility (bottom-up).
 * @param {Array<object>} variants
 */
function deriveProductChannelStatusFromVariants(variants) {
  const list = Array.isArray(variants) ? variants : [];

  const hasActiveEcomm = list.some((v) => {
    const state = v?.channelVisibility?.ecomm;
    return state === 'active' || (state == null && v?.isActive !== false);
  });
  const hasDraftEcomm = list.some((v) => (v?.channelVisibility?.ecomm || 'draft') === 'draft');
  const ecomm = hasActiveEcomm ? 'active' : hasDraftEcomm ? 'draft' : 'archived';

  const wholesale = list.some((v) => hasWholesalePricingConfig(v)) ? 'active' : 'draft';

  return { ecomm, wholesale };
}

/**
 * Keep legacy variant.isActive aligned with ecomm channelVisibility.
 * @param {object} variant
 */
function reconcileVariantLegacyFlagsFromChannelVisibility(variant) {
  if (!variant || typeof variant !== 'object') return;
  variant.isActive = effectiveVariantChannelStatus(variant, 'ecomm') === 'active';
}

/**
 * Push product-level channel changes down to all variants (top-down bulk/admin).
 * @param {object} productDoc mongoose product doc
 * @param {{ ecomm?: string, wholesale?: string }} partial
 */
function propagateProductChannelStatusToVariants(productDoc, partial) {
  if (!productDoc || !Array.isArray(productDoc.variants) || !partial || typeof partial !== 'object') {
    return;
  }
  for (const variant of productDoc.variants) {
    variant.channelVisibility = mergeVariantChannelVisibility(variant, partial);
  }
  if (typeof productDoc.markModified === 'function') {
    productDoc.markModified('variants');
  }
}

/**
 * Single reconcile pass: variants → legacy flags → product channelStatus + status.
 * @param {object} productDoc mongoose product doc
 */
function reconcileProductCatalogState(productDoc) {
  if (!productDoc || !Array.isArray(productDoc.variants)) return;

  for (const variant of productDoc.variants) {
    reconcileVariantLegacyFlagsFromChannelVisibility(variant);
  }

  const derived = deriveProductChannelStatusFromVariants(productDoc.variants);
  productDoc.channelStatus = derived;
  productDoc.status = derived.ecomm;

  if (typeof productDoc.markModified === 'function') {
    productDoc.markModified('variants');
    productDoc.markModified('channelStatus');
  }
}

module.exports = {
  CHANNEL_LIFECYCLE,
  STOREFRONT_KEYS,
  deriveProductChannelStatusFromLegacy,
  deriveVariantChannelVisibilityFromLegacy,
  effectiveProductChannelStatus,
  effectiveVariantChannelStatus,
  isProductListedOnStorefront,
  isVariantListedOnStorefront,
  hasWholesalePricingConfig,
  getVariantAvailability,
  getVariantAvailabilityByStorefront,
  mongoProductCatalogActiveFilter,
  mongoHasVisibleVariantClause,
  mongoCatalogListFilter,
  mongoCatalogAnd,
  mergeProductChannelStatus,
  mergeVariantChannelVisibility,
  filterVariantsForStorefront,
  deriveProductChannelStatusFromVariants,
  reconcileVariantLegacyFlagsFromChannelVisibility,
  propagateProductChannelStatusToVariants,
  reconcileProductCatalogState
};
