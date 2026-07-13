/**
 * Address intelligence for admin Orders.
 *
 * Confirmed against live Shiprocket account:
 * - Standalone Sense Address Score endpoints under /external/... are NOT available (404).
 * - After an order exists on Shiprocket, GET /external/orders/show/{id} returns:
 *   address_score (0–1), address_category (valid|ambiguous|…), address_risk, rto_risk.
 *
 * Therefore:
 * - Pre-Shiprocket (pending): deterministic local quality assessment (honest source label).
 * - Post-Shiprocket: prefer live/cached Shiprocket score from orders/show.
 * - Optional env SHIPROCKET_SENSE_ADDRESS_SCORE_URL for future Sense product wiring.
 */

const axios = require('axios');
const Order = require('../models/Order');
const logger = require('../utils/logger');
const ShiprocketService = require('../utils/shiprocket');
const { validatePhysicalAddressForSave } = require('../utils/addressValidation');
const {
  CATEGORY_LABELS,
  normalizeScorePercent,
  normalizeCategory,
  extractAddressIntelligenceFromShowRoot
} = require('../utils/addressIntelligenceNormalize');

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

/**
 * Deterministic pre-shipment quality check from structured addressSnapshot.
 * @param {object} addr
 */
function computeLocalAddressQuality(addr) {
  const a = addr && typeof addr === 'object' ? addr : {};
  const validation = validatePhysicalAddressForSave({
    fullName: a.fullName || 'Customer',
    phone: a.phone || '9999999999',
    houseNumber: a.houseNumber,
    building: a.building,
    floor: a.floor,
    area: a.area,
    landmark: a.landmark,
    addressLine1: a.addressLine1,
    addressLine2: a.addressLine2,
    city: a.city,
    state: a.state,
    postalCode: a.postalCode,
    country: a.country || 'India'
  });

  let score = 100;
  const reasons = [];

  if (!validation.ok) {
    score -= Math.min(55, 15 * (validation.errors?.length || 1));
    for (const err of validation.errors || []) {
      reasons.push(err.message);
    }
  }

  const line1 = trimStr(a.addressLine1);
  const line2 = trimStr(a.addressLine2);
  const house = trimStr(a.houseNumber);
  const area = trimStr(a.area);
  const city = trimStr(a.city);
  const combined = `${house} ${line1} ${line2} ${area}`.replace(/\s+/g, ' ').trim();

  if (combined.length < 20) {
    score -= 20;
    reasons.push('Street details are quite short for courier delivery.');
  } else if (combined.length < 35) {
    score -= 8;
    reasons.push('Adding landmark or fuller street detail would improve delivery odds.');
  }

  if (/^\d+$/.test(line1.replace(/\s/g, ''))) {
    score -= 25;
    reasons.push('Address line looks numeric-only (high junk risk).');
  }

  if (/(.)\1{5,}/i.test(combined)) {
    score -= 20;
    reasons.push('Repeated characters detected in address text.');
  }

  if (!trimStr(a.landmark) && combined.length < 40) {
    score -= 5;
    reasons.push('No landmark — couriers often need one in dense areas.');
  }

  if (!city || !trimStr(a.state)) {
    score -= 15;
    reasons.push('City/state incomplete.');
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const category = normalizeCategory(null, score);

  return {
    source: 'local_pre_ship',
    available: true,
    scorePercent: score,
    scoreRatio: Number((score / 100).toFixed(2)),
    category,
    categoryLabel: CATEGORY_LABELS[category] || CATEGORY_LABELS.needs_review,
    risk: score >= 80 ? 'low' : score >= 50 ? 'medium' : 'high',
    reasons: reasons.slice(0, 6),
    message:
      category === 'valid'
        ? 'Local pre-ship check looks solid. Shiprocket “Valid Address %” is assigned after the order is created on Shiprocket.'
        : 'Local pre-ship check found issues. Fix address before confirm — Shiprocket score appears after create on Shiprocket.',
    shiprocketSenseStandaloneAvailable: false
  };
}

/**
 * @param {object} input
 */
function buildShiprocketAddressIntelligence(input) {
  const scorePercent = normalizeScorePercent(input?.addressScore ?? input?.address_score);
  if (scorePercent == null && !input?.addressCategory && !input?.address_category) {
    return null;
  }
  const category = normalizeCategory(
    input?.addressCategory || input?.address_category,
    scorePercent
  );
  return {
    source: 'shiprocket',
    available: true,
    scorePercent: scorePercent ?? 0,
    scoreRatio: scorePercent != null ? Number((scorePercent / 100).toFixed(2)) : null,
    category,
    categoryLabel: CATEGORY_LABELS[category] || CATEGORY_LABELS.needs_review,
    risk: String(input?.addressRisk || input?.address_risk || '').toLowerCase() || null,
    rtoRisk: String(input?.rtoRisk || input?.rto_risk || '').toLowerCase() || null,
    reasons: [],
    message: 'Address score from Shiprocket (same signal as panel Valid Address %).',
    syncedAt: input?.addressScoreSyncedAt || input?.syncedAt || null,
    shiprocketSenseStandaloneAvailable: false
  };
}

/**
 * Optional future Sense URL — only used when env is configured.
 * @param {object} addr
 */
async function tryOptionalSenseAddressScore(addr) {
  const url = String(process.env.SHIPROCKET_SENSE_ADDRESS_SCORE_URL || '').trim();
  if (!url) return null;

  try {
    const token = await ShiprocketService.getAuthToken();
    if (!token) return null;
    const { data, status } = await axios.post(
      url,
      {
        address: [addr.houseNumber, addr.building, addr.floor, addr.addressLine1, addr.addressLine2, addr.area]
          .filter(Boolean)
          .join(', '),
        address_2: addr.landmark || '',
        city: addr.city,
        state: addr.state,
        pincode: String(addr.postalCode || '').replace(/\D/g, '').slice(0, 6),
        country: addr.country || 'India'
      },
      {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 15000,
        validateStatus: () => true
      }
    );
    if (status >= 400) {
      logger.warn('[addressIntelligence] Sense URL responded non-OK', { status });
      return null;
    }
    const scorePercent = normalizeScorePercent(
      data?.address_score ?? data?.score ?? data?.data?.address_score ?? data?.data?.score
    );
    const category = normalizeCategory(
      data?.address_category ?? data?.category ?? data?.data?.address_category,
      scorePercent
    );
    if (scorePercent == null) return null;
    return {
      source: 'shiprocket_sense',
      available: true,
      scorePercent,
      scoreRatio: Number((scorePercent / 100).toFixed(2)),
      category,
      categoryLabel: CATEGORY_LABELS[category] || CATEGORY_LABELS.needs_review,
      risk: String(data?.address_risk || data?.risk || '').toLowerCase() || null,
      reasons: [],
      message: 'Address score from configured Shiprocket Sense endpoint.',
      shiprocketSenseStandaloneAvailable: true
    };
  } catch (err) {
    logger.warn('[addressIntelligence] Sense URL call failed', { message: err.message });
    return null;
  }
}

/**
 * @param {string} orderId
 * @param {{ refreshFromShiprocket?: boolean }} [options]
 */
async function getAddressIntelligenceForOrder(orderId, options = {}) {
  const id = String(orderId || '').trim();
  if (!id) {
    const err = new Error('orderId is required');
    err.statusCode = 400;
    err.code = 'ORDER_ID_REQUIRED';
    throw err;
  }

  const order = await Order.findOne({ orderId: id }).lean();
  if (!order) {
    const err = new Error('Order not found');
    err.statusCode = 404;
    err.code = 'ORDER_NOT_FOUND';
    throw err;
  }

  const addr = order.addressSnapshot || {};
  const local = computeLocalAddressQuality(addr);
  const si = order.shipmentInfo || {};
  const hasSr = Boolean(si.shiprocketOrderId || si.shipmentId);

  let shiprocket = null;
  if (hasSr) {
    shiprocket = buildShiprocketAddressIntelligence({
      addressScore: si.addressScore,
      addressCategory: si.addressCategory,
      addressRisk: si.addressRisk,
      rtoRisk: si.rtoRisk,
      addressScoreSyncedAt: si.addressScoreSyncedAt
    });

    const shouldRefresh =
      options.refreshFromShiprocket === true || !shiprocket || shiprocket.scorePercent == null;

    if (shouldRefresh && ShiprocketService.enabled) {
      try {
        const lookup = await ShiprocketService.fetchForwardOrderSnapshot({
          shiprocketOrderId: si.shiprocketOrderId,
          channelOrderId: order.orderId
        });
        if (lookup.success && lookup.raw) {
          const extracted = extractAddressIntelligenceFromShowRoot(lookup.raw);
          shiprocket = buildShiprocketAddressIntelligence({
            ...extracted,
            syncedAt: new Date().toISOString()
          });
          if (shiprocket) {
            await Order.updateOne(
              { orderId: id },
              {
                $set: {
                  'shipmentInfo.addressScore': shiprocket.scoreRatio,
                  'shipmentInfo.addressCategory': shiprocket.category,
                  'shipmentInfo.addressRisk': shiprocket.risk,
                  'shipmentInfo.rtoRisk': shiprocket.rtoRisk,
                  'shipmentInfo.addressScoreSyncedAt': new Date()
                }
              }
            );
          }
        }
      } catch (err) {
        logger.warn('[addressIntelligence] refresh from Shiprocket failed', {
          orderId: id,
          message: err.message
        });
      }
    }
  }

  const sense = !hasSr ? await tryOptionalSenseAddressScore(addr) : null;
  const primary = shiprocket || sense || local;

  return {
    orderId: id,
    orderStatus: order.orderStatus,
    hasShiprocketOrder: hasSr,
    primary,
    local,
    shiprocket,
    sense,
    access: {
      shiprocketOrdersShowScore: true,
      shiprocketSenseStandaloneApi: Boolean(
        String(process.env.SHIPROCKET_SENSE_ADDRESS_SCORE_URL || '').trim()
      ),
      note:
        'Standalone Sense Address Score paths under standard /external API returned 404 for this account. Panel Valid Address % is available on orders/show after Shiprocket order create.'
    }
  };
}

module.exports = {
  CATEGORY_LABELS,
  normalizeScorePercent,
  normalizeCategory,
  computeLocalAddressQuality,
  buildShiprocketAddressIntelligence,
  extractAddressIntelligenceFromShowRoot,
  getAddressIntelligenceForOrder,
  tryOptionalSenseAddressScore
};
