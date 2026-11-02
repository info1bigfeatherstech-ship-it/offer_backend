'use strict';

const SameDayDeliverySettings = require('../../models/SameDayDeliverySettings');
const {
  normalizePincode,
  isValidPincode,
  createSddHttpError,
} = require('../utils/sameDayDeliveryMode');

const STOREFRONT = 'ecomm';
const MAX_PINCODES = 5000;

async function getSettings() {
  try {
    return await SameDayDeliverySettings.findOneAndUpdate(
      { storefront: STOREFRONT },
      { $setOnInsert: { enabled: false, pincodes: [] } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (err) {
    if (err && err.code === 11000) {
      const existing = await SameDayDeliverySettings.findOne({ storefront: STOREFRONT });
      if (existing) return existing;
    }
    throw err;
  }
}

function serializeSettings(doc) {
  const pincodes = Array.isArray(doc.pincodes) ? doc.pincodes : [];
  return {
    storefront: STOREFRONT,
    enabled: Boolean(doc.enabled),
    pincodes,
    pincodeCount: pincodes.length,
    updatedAt: doc.updatedAt || null,
  };
}

function normalizePincodeList(raw) {
  if (raw == null) return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(/[\s,]+/);
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const pin = normalizePincode(item);
    if (!pin) continue;
    if (!isValidPincode(pin)) {
      throw createSddHttpError(400, 'INVALID_PINCODE', `Invalid pincode: ${item}`, 'pincodes');
    }
    if (seen.has(pin)) continue;
    seen.add(pin);
    out.push(pin);
    if (out.length > MAX_PINCODES) {
      throw createSddHttpError(
        400,
        'TOO_MANY_PINCODES',
        `Maximum ${MAX_PINCODES} pincodes allowed`,
        'pincodes'
      );
    }
  }
  return out;
}

async function updateSettings({ enabled, pincodes, updatedBy } = {}) {
  const doc = await getSettings();
  if (enabled !== undefined) doc.enabled = Boolean(enabled);
  if (pincodes !== undefined) doc.pincodes = normalizePincodeList(pincodes);
  if (updatedBy) doc.updatedBy = updatedBy;
  await doc.save();
  return doc;
}

async function isPincodeEligible(rawPincode) {
  const pin = normalizePincode(rawPincode);
  if (!isValidPincode(pin)) return { eligible: false, enabled: false, pincode: pin || null };
  const doc = await getSettings();
  const enabled = Boolean(doc.enabled);
  const listed = enabled && Array.isArray(doc.pincodes) && doc.pincodes.includes(pin);
  return { eligible: listed, enabled, pincode: pin };
}

async function assertPincodeEligible(rawPincode) {
  const result = await isPincodeEligible(rawPincode);
  if (!result.enabled) {
    throw createSddHttpError(
      400,
      'SAME_DAY_DISABLED',
      'Same day delivery is not enabled.',
      'deliveryMode'
    );
  }
  if (!result.eligible) {
    throw createSddHttpError(
      400,
      'SAME_DAY_PINCODE_NOT_ELIGIBLE',
      'Same day delivery is not available for this pincode.',
      'pincode'
    );
  }
  return result;
}

module.exports = {
  STOREFRONT,
  getSettings,
  serializeSettings,
  updateSettings,
  isPincodeEligible,
  assertPincodeEligible,
};
