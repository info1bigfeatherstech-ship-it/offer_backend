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
    autoPushHourIst: getAutoPushHourIst(),
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

async function updateAutoPushEnabled(storefront, enabled, updatedByUserId = null) {
  const sf = normalizeStorefront(storefront);
  const autoPushEnabled = Boolean(enabled);

  const doc = await LeadsPushSettings.findOneAndUpdate(
    { storefront: sf },
    {
      $set: {
        autoPushEnabled,
        updatedBy: updatedByUserId || null,
      },
      $setOnInsert: { storefront: sf },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();

  logger.info('[leadsPushSettings] auto push toggled', {
    storefront: sf,
    autoPushEnabled,
    updatedBy: updatedByUserId ? String(updatedByUserId) : null,
  });

  return toAdminPayload(doc);
}

module.exports = {
  normalizeStorefront,
  getAutoPushHourIst,
  getAdminSettings,
  isAutoPushEnabled,
  updateAutoPushEnabled,
};
