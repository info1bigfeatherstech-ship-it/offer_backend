/**
 * Variant catalog fields: primary variant (variants[0]) always uses product-level
 * title, description, shipping. Additional variants use their own fields with
 * product fallback (Option B for extras only).
 */

const DEFAULT_UNIT_WEIGHT_KG = 0.5;
const DEFAULT_DIM_CM = 1;

function parsePositiveNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return num;
}

function roundMoney2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function shippingDimCm(value, fallback = DEFAULT_DIM_CM) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function getPrimaryVariantId(product) {
  const first = product?.variants?.[0];
  return first?._id != null ? String(first._id) : null;
}

function isPrimaryVariant(variant, product) {
  if (!variant) return true;
  const primaryId = getPrimaryVariantId(product);
  if (primaryId && variant._id != null) {
    return String(variant._id) === primaryId;
  }
  if (!Array.isArray(product?.variants) || product.variants.length === 0) return true;
  return product.variants[0] === variant;
}

function isPrimaryVariantIndex(variantIndex) {
  return Number(variantIndex) === 0;
}

function hasCompleteVariantShipping(variant) {
  if (!variant?.shipping) return false;
  const d = variant.shipping.dimensions || {};
  return (
    parsePositiveNumber(variant.shipping.weight) != null &&
    parsePositiveNumber(d.length) != null &&
    parsePositiveNumber(d.width) != null &&
    parsePositiveNumber(d.height) != null
  );
}

function normalizeShippingObject(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const weight = parsePositiveNumber(raw.weight);
  const dimensions = raw.dimensions && typeof raw.dimensions === 'object' ? raw.dimensions : {};
  const length = parsePositiveNumber(dimensions.length);
  const width = parsePositiveNumber(dimensions.width);
  const height = parsePositiveNumber(dimensions.height);
  if (weight == null || length == null || width == null || height == null) return null;
  return {
    weight,
    dimensions: { length, width, height }
  };
}

function resolveProductShipping(product) {
  const fromProduct = normalizeShippingObject(product?.shipping);
  if (fromProduct) return fromProduct;
  return {
    weight: DEFAULT_UNIT_WEIGHT_KG,
    dimensions: {
      length: DEFAULT_DIM_CM,
      width: DEFAULT_DIM_CM,
      height: DEFAULT_DIM_CM
    }
  };
}

function resolveVariantShipping(variant, product) {
  if (isPrimaryVariant(variant, product)) {
    return resolveProductShipping(product);
  }
  const fromVariant = normalizeShippingObject(variant?.shipping);
  if (fromVariant) return fromVariant;
  return resolveProductShipping(product);
}

function resolveVariantTitle(variant, product) {
  if (isPrimaryVariant(variant, product)) {
    const productTitle = String(product?.title ?? '').trim();
    if (productTitle) return productTitle;
    return String(product?.name ?? '').trim() || 'Product';
  }
  const variantTitle = String(variant?.title ?? '').trim();
  if (variantTitle) return variantTitle;
  const productTitle = String(product?.title ?? '').trim();
  if (productTitle) return productTitle;
  return String(product?.name ?? '').trim() || 'Product';
}

function resolveVariantDescription(variant, product) {
  if (isPrimaryVariant(variant, product)) {
    return String(product?.description ?? '').trim();
  }
  const variantDesc = String(variant?.description ?? '').trim();
  if (variantDesc) return variantDesc;
  return String(product?.description ?? '').trim();
}

function parseVariantShippingForStorage(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return normalizeShippingObject(parsed);
}

function parseVariantTextForStorage(value) {
  if (value === undefined || value === null) return undefined;
  const trimmed = String(value).trim();
  return trimmed || undefined;
}

function applyVariantCatalogFieldsToTarget(target, input = {}, { isPrimary = false } = {}) {
  if (!target || typeof target !== 'object') return target;
  if (isPrimary) {
    delete target.title;
    delete target.description;
    delete target.shipping;
    return target;
  }
  if (input.title !== undefined) {
    const title = parseVariantTextForStorage(input.title);
    if (title) target.title = title;
    else delete target.title;
  }
  if (input.description !== undefined) {
    const description = parseVariantTextForStorage(input.description);
    if (description) target.description = description;
    else delete target.description;
  }
  if (input.shipping !== undefined) {
    const shipping = parseVariantShippingForStorage(input.shipping);
    if (shipping) target.shipping = shipping;
    else delete target.shipping;
  }
  return target;
}

function buildVariantCatalogFieldsFromImportRow(row, { applyVariantCatalog = true } = {}) {
  if (!applyVariantCatalog) return {};
  const fields = {};
  const title = parseVariantTextForStorage(row.variantTitle ?? row.title);
  const description = parseVariantTextForStorage(row.variantDescription ?? row.description);
  if (title) fields.title = title;
  if (description) fields.description = description;
  const shipping = parseVariantShippingForStorage({
    weight: row.weight,
    dimensions: { length: row.length, width: row.width, height: row.height }
  });
  if (shipping) fields.shipping = shipping;
  return fields;
}

function validateVariantsResolvableShipping(productShipping, variants = [], product = null) {
  const productStub = product || { shipping: productShipping };
  if (productShipping && !productStub.shipping) {
    productStub.shipping = productShipping;
  }
  for (let i = 0; i < variants.length; i++) {
    const resolved = resolveVariantShipping(variants[i], productStub);
    if (!normalizeShippingObject(resolved)) {
      const label = i === 0 ? 'primary variant (product shipping)' : `variant ${i}`;
      return { valid: false, message: `Shipping weight and dimensions (L×W×H) are required for ${label}.` };
    }
  }
  return { valid: true };
}

function unitWeightKgFromResolvedShipping(shipping) {
  const w = parsePositiveNumber(shipping?.weight);
  return Math.max(0.05, roundMoney2(w ?? DEFAULT_UNIT_WEIGHT_KG));
}

function unitDimsCmFromResolvedShipping(shipping) {
  const d = shipping?.dimensions || {};
  const length = parsePositiveNumber(d.length);
  const width = parsePositiveNumber(d.width);
  const height = parsePositiveNumber(d.height);
  if (!length || !width || !height) return null;
  return { lengthCm: Math.max(1, length), widthCm: Math.max(1, width), heightCm: Math.max(1, height) };
}

module.exports = {
  DEFAULT_UNIT_WEIGHT_KG,
  DEFAULT_DIM_CM,
  parsePositiveNumber,
  roundMoney2,
  shippingDimCm,
  isPrimaryVariant,
  isPrimaryVariantIndex,
  hasCompleteVariantShipping,
  normalizeShippingObject,
  resolveProductShipping,
  resolveVariantShipping,
  resolveVariantTitle,
  resolveVariantDescription,
  parseVariantShippingForStorage,
  parseVariantTextForStorage,
  applyVariantCatalogFieldsToTarget,
  buildVariantCatalogFieldsFromImportRow,
  validateVariantsResolvableShipping,
  unitWeightKgFromResolvedShipping,
  unitDimsCmFromResolvedShipping
};
