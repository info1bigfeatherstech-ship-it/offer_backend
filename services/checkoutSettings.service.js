const CheckoutSettings = require('../models/CheckoutSettings');
const logger = require('../utils/logger');

const VALID_STOREFRONTS = new Set(['ecomm', 'wholesale']);

const DEFAULTS = Object.freeze({
  partialPaymentEnabled: true,
  partialPaymentPercent: 25,
  codEnabled: true
});

function normalizeStorefront(value) {
  const s = String(value || 'ecomm').toLowerCase().trim();
  return VALID_STOREFRONTS.has(s) ? s : 'ecomm';
}

function clampPercent(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  const rounded = Math.round(x * 100) / 100;
  if (rounded < 1 || rounded > 100) return null;
  return rounded;
}

/**
 * Public policy shape returned to clients and used in checkout enforcement.
 */
function toPublicPolicy(doc) {
  if (!doc) {
    return {
      storefront: 'ecomm',
      codEnabled: DEFAULTS.codEnabled,
      partialPaymentEnabled: DEFAULTS.partialPaymentEnabled,
      partialPaymentPercent: DEFAULTS.partialPaymentPercent
    };
  }
  const partialOn = Boolean(doc.partialPaymentEnabled);
  const pct = partialOn && doc.partialPaymentPercent != null
    ? clampPercent(doc.partialPaymentPercent)
    : null;
  return {
    storefront: doc.storefront,
    codEnabled: Boolean(doc.codEnabled),
    partialPaymentEnabled: partialOn,
    partialPaymentPercent: pct ?? (partialOn ? DEFAULTS.partialPaymentPercent : null)
  };
}

async function getOrCreateSettings(storefront) {
  const sf = normalizeStorefront(storefront);
  let doc = await CheckoutSettings.findOne({ storefront: sf }).lean();
  if (doc) {
    return doc;
  }
  try {
    doc = await CheckoutSettings.create({
      storefront: sf,
      partialPaymentEnabled: DEFAULTS.partialPaymentEnabled,
      partialPaymentPercent: DEFAULTS.partialPaymentPercent,
      codEnabled: DEFAULTS.codEnabled
    });
    logger.info('[checkoutSettings] Created default settings', { storefront: sf });
    return doc.toObject();
  } catch (err) {
    if (err?.code === 11000) {
      return CheckoutSettings.findOne({ storefront: sf }).lean();
    }
    throw err;
  }
}

/**
 * @param {string} storefront
 */
async function getPolicyForStorefront(storefront) {
  const doc = await getOrCreateSettings(storefront);
  return toPublicPolicy(doc);
}

/**
 * Merge admin PATCH with current row. Enforces: if partialPaymentEnabled true → valid percent required.
 * If partialPaymentEnabled false in this request → reject body.partialPaymentPercent if present.
 */
async function applyAdminPatch(storefront, body, updatedByUserId) {
  const errors = [];
  if (!body || typeof body !== 'object') {
    return { ok: false, errors: ['Request body is required'] };
  }
  if (
    body.codEnabled === undefined &&
    body.partialPaymentEnabled === undefined &&
    body.partialPaymentPercent === undefined
  ) {
    return { ok: false, errors: ['Provide at least one of: codEnabled, partialPaymentEnabled, partialPaymentPercent'] };
  }

  if (body.partialPaymentEnabled === false &&
    body.partialPaymentPercent !== undefined &&
    body.partialPaymentPercent !== null &&
    String(body.partialPaymentPercent).trim() !== '') {
    return {
      ok: false,
      errors: ['When partialPaymentEnabled is false, do not send partialPaymentPercent']
    };
  }

  if (body.partialPaymentEnabled !== undefined && typeof body.partialPaymentEnabled !== 'boolean') {
    errors.push('partialPaymentEnabled must be a boolean');
  }
  if (body.codEnabled !== undefined && typeof body.codEnabled !== 'boolean') {
    errors.push('codEnabled must be a boolean');
  }
  if (errors.length) {
    return { ok: false, errors };
  }

  const sf = normalizeStorefront(storefront);
  const current = await getOrCreateSettings(sf);

  const merged = {
    codEnabled: body.codEnabled !== undefined ? Boolean(body.codEnabled) : Boolean(current.codEnabled),
    partialPaymentEnabled:
      body.partialPaymentEnabled !== undefined
        ? Boolean(body.partialPaymentEnabled)
        : Boolean(current.partialPaymentEnabled),
    partialPaymentPercent:
      body.partialPaymentPercent !== undefined
        ? body.partialPaymentPercent
        : current.partialPaymentPercent
  };

  if (merged.partialPaymentEnabled) {
    const c = clampPercent(merged.partialPaymentPercent);
    if (c == null) {
      return {
        ok: false,
        errors: ['partialPaymentPercent must be a number between 1 and 100 when partial payment is enabled']
      };
    }
    merged.partialPaymentPercent = c;
  } else {
    merged.partialPaymentPercent = null;
  }

  const doc = await CheckoutSettings.findOneAndUpdate(
    { storefront: sf },
    {
      $set: {
        codEnabled: merged.codEnabled,
        partialPaymentEnabled: merged.partialPaymentEnabled,
        partialPaymentPercent: merged.partialPaymentPercent,
        updatedBy: updatedByUserId || null
      }
    },
    { new: true, runValidators: true }
  ).lean();

  if (!doc) {
    const err = new Error('Checkout settings not found after update');
    err.statusCode = 500;
    err.code = 'CHECKOUT_SETTINGS_UPDATE_FAILED';
    throw err;
  }

  return { ok: true, policy: toPublicPolicy(doc) };
}

module.exports = {
  normalizeStorefront,
  clampPercent,
  getPolicyForStorefront,
  getOrCreateSettings,
  toPublicPolicy,
  applyAdminPatch,
  DEFAULTS
};
