/**
 * RTO platform fee tiers — loaded from RTO_PLATFORM_FEE_TIERS env (JSON).
 * Percent applied on order total (subtotal + deliveryCharges); each tier has a max cap (INR).
 */
const logger = require('../utils/logger');

const DEFAULT_TIERS = [
  { min: 100, max: 200, percent: 8, cap: 16 },
  { min: 201, max: 500, percent: 6, cap: 30 },
  { min: 501, max: 1000, percent: 5, cap: 50 },
  { min: 1001, max: null, percent: 4.5, cap: 200 }
];

let cachedTiers = null;

function normalizeTier(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const min = Number(raw.min);
  const max = raw.max == null || raw.max === '' ? null : Number(raw.max);
  const percent = Number(raw.percent);
  const cap = Number(raw.cap);
  if (!Number.isFinite(min) || !Number.isFinite(percent) || !Number.isFinite(cap)) return null;
  if (max != null && (!Number.isFinite(max) || max < min)) return null;
  return { min, max, percent, cap };
}

function loadPlatformFeeTiers() {
  if (cachedTiers) return cachedTiers;

  const raw = process.env.RTO_PLATFORM_FEE_TIERS;
  if (!raw || !String(raw).trim()) {
    cachedTiers = DEFAULT_TIERS;
    return cachedTiers;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.length) {
      throw new Error('RTO_PLATFORM_FEE_TIERS must be a non-empty JSON array');
    }
    const tiers = parsed.map(normalizeTier).filter(Boolean);
    if (!tiers.length) {
      throw new Error('No valid tiers in RTO_PLATFORM_FEE_TIERS');
    }
    tiers.sort((a, b) => a.min - b.min);
    cachedTiers = tiers;
    return cachedTiers;
  } catch (err) {
    logger.warn('[rtoPlatformFee] Invalid RTO_PLATFORM_FEE_TIERS — using defaults', {
      message: err.message
    });
    cachedTiers = DEFAULT_TIERS;
    return cachedTiers;
  }
}

function resetPlatformFeeTiersCache() {
  cachedTiers = null;
}

module.exports = {
  loadPlatformFeeTiers,
  resetPlatformFeeTiersCache,
  DEFAULT_TIERS
};
