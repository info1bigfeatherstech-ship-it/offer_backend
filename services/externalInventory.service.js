/**
 * Inventory software internal stock client (Postgres SSOT).
 *
 * Phase 1: getStockBatch (read).
 * Phase 2+: reserveStock / commitStock / releaseStock (wired later).
 *
 * Production safety:
 * - Never throws to callers for read path (degraded + empty stock map)
 * - Kill switch: INVENTORY_STOCK_ENABLED=false
 * - Requires BASE_URL + API_KEY
 * - Timeout + chunked batch (max 200 codes)
 */

const axios = require('axios');
const logger = require('../utils/logger');
const { normalizeProductCode } = require('../utils/productCode');

const BATCH_CHUNK_SIZE = 200;

function envFlagTrue(name, defaultWhenUnset = false) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return defaultWhenUnset;
  const v = String(raw).trim().toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  return defaultWhenUnset;
}

function getConfig() {
  const baseUrl = String(process.env.INVENTORY_STOCK_BASE_URL || '')
    .trim()
    .replace(/\/+$/, '');
  const apiKey = String(process.env.INVENTORY_STOCK_API_KEY || '').trim();
  const timeoutMs = Math.max(
    500,
    Math.min(30000, Number(process.env.INVENTORY_STOCK_TIMEOUT_MS) || 5000)
  );
  // Kill switch: INVENTORY_STOCK_ENABLED=false disables even when URL/key set.
  // Unset + URL+key present → enabled (local/prod once configured).
  const configured = Boolean(baseUrl && apiKey);
  const flagRaw = process.env.INVENTORY_STOCK_ENABLED;
  const flagUnset = flagRaw == null || String(flagRaw).trim() === '';
  const enabled = configured && (flagUnset ? true : envFlagTrue('INVENTORY_STOCK_ENABLED', false));

  return { baseUrl, apiKey, timeoutMs, enabled };
}

function isInventoryStockEnabled() {
  return getConfig().enabled;
}

function createClient() {
  const { baseUrl, apiKey, timeoutMs } = getConfig();
  return axios.create({
    baseURL: baseUrl,
    timeout: timeoutMs,
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey
    },
    validateStatus: () => true
  });
}

function uniqueNormalizedCodes(codes) {
  const out = [];
  const seen = new Set();
  for (const raw of codes || []) {
    const code = normalizeProductCode(raw);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * Parse inventory batch payload into a Map<code, availableQty>.
 */
function parseStockMap(stockObj) {
  const map = new Map();
  if (!stockObj || typeof stockObj !== 'object') return map;
  for (const [key, value] of Object.entries(stockObj)) {
    const code = normalizeProductCode(key);
    if (!code) continue;
    let available;
    if (typeof value === 'number') {
      available = value;
    } else if (value && typeof value === 'object') {
      available = Number(value.available);
    } else {
      available = Number(value);
    }
    if (!Number.isFinite(available)) continue;
    map.set(code, Math.max(0, Math.floor(available)));
  }
  return map;
}

function degradedBatchResult(codes, reason, extra = {}) {
  const normalized = uniqueNormalizedCodes(codes);
  return {
    ok: false,
    degraded: true,
    reason,
    warehouseId: null,
    stock: new Map(),
    missing: normalized,
    requestId: null,
    ...extra
  };
}

/**
 * POST /batch — read available qty by productCode.
 * @param {string[]} codes
 * @returns {Promise<{
 *   ok: boolean,
 *   degraded: boolean,
 *   reason: string|null,
 *   warehouseId: string|null,
 *   stock: Map<string, number>,
 *   missing: string[],
 *   requestId: string|null
 * }>}
 */
async function getStockBatch(codes) {
  const cfg = getConfig();
  const normalized = uniqueNormalizedCodes(codes);

  if (!cfg.enabled) {
    return degradedBatchResult(normalized, 'disabled');
  }
  if (normalized.length === 0) {
    return {
      ok: true,
      degraded: false,
      reason: null,
      warehouseId: null,
      stock: new Map(),
      missing: [],
      requestId: null
    };
  }

  try {
    const client = createClient();
    const merged = new Map();
    const missingSet = new Set();
    let warehouseId = null;
    let requestId = null;

    for (const chunk of chunkArray(normalized, BATCH_CHUNK_SIZE)) {
      const res = await client.post('/batch', { codes: chunk });
      requestId = res.data?.requestId || requestId;

      if (res.status === 401 || res.status === 503) {
        const code = res.data?.code || (res.status === 401 ? 'INVALID_API_KEY' : 'INTERNAL_STOCK_API_DISABLED');
        logger.warn('[externalInventory] batch auth/config error', {
          status: res.status,
          code,
          requestId
        });
        return degradedBatchResult(normalized, code, { requestId });
      }

      if (res.status === 409) {
        const code = res.data?.code || 'ONLINE_WAREHOUSE_NOT_CONFIGURED';
        logger.warn('[externalInventory] batch warehouse misconfigured', {
          status: res.status,
          code,
          requestId
        });
        return degradedBatchResult(normalized, code, { requestId });
      }

      if (res.status < 200 || res.status >= 300 || !res.data?.success) {
        logger.warn('[externalInventory] batch unexpected response', {
          status: res.status,
          code: res.data?.code || null,
          message: res.data?.message || null,
          requestId
        });
        return degradedBatchResult(normalized, res.data?.code || `HTTP_${res.status}`, { requestId });
      }

      const data = res.data.data || {};
      if (data.warehouse_id) warehouseId = data.warehouse_id;

      const chunkMap = parseStockMap(data.stock);
      for (const [k, v] of chunkMap) merged.set(k, v);

      for (const m of data.missing || []) {
        const mc = normalizeProductCode(m);
        if (mc) missingSet.add(mc);
      }
    }

    // Any requested code not in stock map is missing (fallback to Mongo).
    for (const code of normalized) {
      if (!merged.has(code)) missingSet.add(code);
    }

    return {
      ok: true,
      degraded: false,
      reason: null,
      warehouseId,
      stock: merged,
      missing: [...missingSet],
      requestId
    };
  } catch (err) {
    logger.warn('[externalInventory] batch request failed — degrading to Mongo', {
      message: err.message,
      code: err.code || null
    });
    return degradedBatchResult(normalized, err.code || 'NETWORK_ERROR');
  }
}

async function postStockAction(path, body) {
  const cfg = getConfig();
  if (!cfg.enabled) {
    const err = new Error('Inventory stock API disabled');
    err.code = 'INTERNAL_STOCK_API_DISABLED';
    err.degraded = true;
    throw err;
  }

  try {
    const client = createClient();
    const res = await client.post(path, body);
    const requestId = res.data?.requestId || null;
    const payload = {
      httpStatus: res.status,
      success: Boolean(res.data?.success),
      message: res.data?.message || null,
      code: res.data?.code || null,
      data: res.data?.data || null,
      details: res.data?.details || null,
      requestId,
      degraded: false
    };

    if (res.status === 401 || res.status === 503) {
      payload.degraded = true;
      payload.code = payload.code || (res.status === 401 ? 'INVALID_API_KEY' : 'INTERNAL_STOCK_API_DISABLED');
    }

    return payload;
  } catch (err) {
    const wrapped = new Error(err.message || 'Inventory stock request failed');
    wrapped.code = err.code || 'NETWORK_ERROR';
    wrapped.degraded = true;
    wrapped.cause = err;
    throw wrapped;
  }
}

/** Phase 2 — hold stock at checkout */
async function reserveStock({ orderId, storefront = 'ecomm', lines }) {
  return postStockAction('/reserve', { orderId, storefront, lines });
}

/** Phase 2 — confirm sold after payment / COD confirm */
async function commitStock({ orderId }) {
  return postStockAction('/commit', { orderId });
}

/** Phase 2 — cancel / fail / abandon */
async function releaseStock({ orderId }) {
  return postStockAction('/release', { orderId });
}

module.exports = {
  isInventoryStockEnabled,
  getConfig,
  getStockBatch,
  reserveStock,
  commitStock,
  releaseStock,
  normalizeProductCode,
  uniqueNormalizedCodes,
  parseStockMap
};
