const LeadsPushSettings = require('../models/LeadsPushSettings');
const { isPushConfigured } = require('../utils/pushVapid');
const logger = require('../utils/logger');

const VALID_STOREFRONTS = new Set(['ecomm', 'wholesale']);

function normalizeStorefront(value) {
  const s = String(value || 'ecomm').toLowerCase().trim();
  return VALID_STOREFRONTS.has(s) ? s : 'ecomm';
}

function getAutoPushHourIst() {
  const raw = Number(process.env.CART_REMINDER_PUSH_AUTO_HOUR_IST);
  if (Number.isFinite(raw) && raw >= 0 && raw <= 23) return Math.floor(raw);
  return 18;
}

async function getOrCreateSettings(storefront) {
  const sf = normalizeStorefront(storefront);
  let doc = await LeadsPushSettings.findOne({ storefront: sf }).lean();
  if (doc) return doc;

  try {
    const created = await LeadsPushSettings.create({
      storefront: sf,
      autoPushEnabled: false,
      newProductsAutoPushEnabled: false,
      wishlistAutoPushEnabled: false,
    });
    logger.info('[leadsPushSettings] Created default settings', { storefront: sf });
    return created.toObject();
  } catch (err) {
    if (err?.code === 11000) {
      return LeadsPushSettings.findOne({ storefront: sf }).lean();
    }
    throw err;
  }
}

function toAdminPayload(doc) {
  return {
    storefront: doc?.storefront || 'ecomm',
    autoPushEnabled: Boolean(doc?.autoPushEnabled),
    newProductsAutoPushEnabled: Boolean(doc?.newProductsAutoPushEnabled),
    wishlistAutoPushEnabled: Boolean(doc?.wishlistAutoPushEnabled),
    lastNewProductsDigestAt: doc?.lastNewProductsDigestAt || null,
    autoPushHourIst: getAutoPushHourIst(),
    newProductsWindowsIst: ['11:00–13:00', '18:00–20:00'],
    pushConfigured: isPushConfigured(),
    updatedAt: doc?.updatedAt || null,
  };
}

async function getAdminSettings(storefront) {
  const doc = await getOrCreateSettings(storefront);
  return toAdminPayload(doc);
}

async function isAutoPushEnabled(storefront) {
  const doc = await getOrCreateSettings(storefront);
  return Boolean(doc?.autoPushEnabled);
}

async function isNewProductsAutoPushEnabled(storefront) {
  const doc = await getOrCreateSettings(storefront);
  return Boolean(doc?.newProductsAutoPushEnabled);
}

async function isWishlistAutoPushEnabled(storefront) {
  const doc = await getOrCreateSettings(storefront);
  return Boolean(doc?.wishlistAutoPushEnabled);
}

async function updateAutoPushEnabled(storefront, enabled, updatedByUserId = null) {
  return updatePushSettings(storefront, { autoPushEnabled: Boolean(enabled) }, updatedByUserId);
}

/**
 * Partial update for push policy flags.
 * @param {string} storefront
 * @param {{ autoPushEnabled?: boolean, newProductsAutoPushEnabled?: boolean, wishlistAutoPushEnabled?: boolean }} patch
 * @param {string|null} updatedByUserId
 */
async function updatePushSettings(storefront, patch = {}, updatedByUserId = null) {
  const sf = normalizeStorefront(storefront);
  const $set = {
    updatedBy: updatedByUserId || null,
  };

  let touched = false;
  if (patch.autoPushEnabled !== undefined) {
    $set.autoPushEnabled = Boolean(patch.autoPushEnabled);
    touched = true;
  }
  if (patch.newProductsAutoPushEnabled !== undefined) {
    $set.newProductsAutoPushEnabled = Boolean(patch.newProductsAutoPushEnabled);
    touched = true;
  }
  if (patch.wishlistAutoPushEnabled !== undefined) {
    $set.wishlistAutoPushEnabled = Boolean(patch.wishlistAutoPushEnabled);
    touched = true;
  }

  if (!touched) {
    const err = new Error(
      'Provide at least one of: autoPushEnabled, newProductsAutoPushEnabled, wishlistAutoPushEnabled'
    );
    err.code = 'PUSH_SETTINGS_PATCH_REQUIRED';
    throw err;
  }

  const doc = await LeadsPushSettings.findOneAndUpdate(
    { storefront: sf },
    {
      $set,
      $setOnInsert: { storefront: sf },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();

  logger.info('[leadsPushSettings] settings updated', {
    storefront: sf,
    patch: $set,
    updatedBy: updatedByUserId ? String(updatedByUserId) : null,
  });

  return toAdminPayload(doc);
}

async function getSettingsDoc(storefront) {
  return getOrCreateSettings(storefront);
}

async function markNewProductsDigestSent(storefront, { slot, dateKey, digestAt, updateWatermark = true }) {
  const sf = normalizeStorefront(storefront);
  const $set = {};
  if (updateWatermark) {
    $set.lastNewProductsDigestAt = digestAt instanceof Date ? digestAt : new Date();
  }
  if (slot === 'morning') $set.lastNewProductsMorningDateKey = dateKey;
  if (slot === 'evening') $set.lastNewProductsEveningDateKey = dateKey;

  if (!Object.keys($set).length) return;

  await LeadsPushSettings.findOneAndUpdate(
    { storefront: sf },
    { $set, $setOnInsert: { storefront: sf } },
    { upsert: true }
  );
}

module.exports = {
  normalizeStorefront,
  getAutoPushHourIst,
  getAdminSettings,
  isAutoPushEnabled,
  isNewProductsAutoPushEnabled,
  isWishlistAutoPushEnabled,
  updateAutoPushEnabled,
  updatePushSettings,
  getSettingsDoc,
  markNewProductsDigestSent,
};
