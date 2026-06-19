/**
 * Background status sync for admin Orders tab — pulls Shiprocket state into our DB
 * via existing reconcileOrderFromShiprocket (no Shiprocket logic changes).
 */
const Order = require('../models/Order');
const {
  ACTIVE_FORWARD_SYNC_STATUSES,
  isActiveForwardSyncOrderStatus,
} = require('../constants/adminOrderFulfillmentBuckets');
const { reconcileOrderFromShiprocket } = require('./shiprocketReconcile.service');

const DEFAULT_STALE_MS = 5 * 60 * 1000;
const DEFAULT_CONCURRENCY = 4;
/** Per-request wall clock — drains all stale orders in range until empty or this limit. */
const DEFAULT_MAX_RUN_MS = 120 * 1000;
const FETCH_CHUNK_MULTIPLIER = 5;

/**
 * @param {object | null | undefined} shipmentInfo
 */
function hasShiprocketReference(shipmentInfo) {
  const si = shipmentInfo || {};
  return Boolean(
    si.shiprocketOrderId || si.shipmentId || si.awbCode || si.trackingNumber
  );
}

/**
 * @param {{ from: Date, to: Date, scopeMatch?: object, staleMs?: number }} opts
 */
function buildAutoSyncCandidateFilter(opts) {
  const staleMs = Number.isFinite(Number(opts.staleMs)) ? Number(opts.staleMs) : DEFAULT_STALE_MS;
  const cutoff = new Date(Date.now() - staleMs);
  const dateMatch = { createdAt: { $gte: opts.from, $lte: opts.to } };
  const scopeMatch = opts.scopeMatch && Object.keys(opts.scopeMatch).length ? opts.scopeMatch : null;
  const base = scopeMatch ? { $and: [dateMatch, scopeMatch] } : dateMatch;

  return {
    $and: [
      base,
      { orderStatus: { $in: [...ACTIVE_FORWARD_SYNC_STATUSES] } },
      {
        $or: [
          { 'shipmentInfo.shiprocketOrderId': { $exists: true, $nin: [null, ''] } },
          { 'shipmentInfo.shipmentId': { $exists: true, $nin: [null, ''] } },
          { 'shipmentInfo.awbCode': { $exists: true, $nin: [null, ''] } },
          { 'shipmentInfo.trackingNumber': { $exists: true, $nin: [null, ''] } },
        ],
      },
      {
        $or: [
          { 'shipmentInfo.lastSyncAt': { $exists: false } },
          { 'shipmentInfo.lastSyncAt': null },
          { 'shipmentInfo.lastSyncAt': { $lt: cutoff } },
        ],
      },
    ],
  };
}

/**
 * @template R
 * @param {string[]} ids
 * @param {number} parallel
 * @param {(id: string) => Promise<R>} handler
 */
async function mapInConcurrentWindows(ids, parallel, handler) {
  const out = [];
  const limit = Math.min(Math.max(1, parallel), Math.max(1, ids.length));
  for (let i = 0; i < ids.length; i += limit) {
    const window = ids.slice(i, i + limit);
    const batch = await Promise.all(
      window.map((id) =>
        handler(id).catch((err) => ({
          orderId: id,
          success: false,
          updated: false,
          skipped: false,
          code: 'UNHANDLED',
          message: err?.message || String(err),
        }))
      )
    );
    out.push(...batch);
  }
  return out;
}

/**
 * @param {string} orderId
 */
async function runAutoSyncSingle(orderId) {
  const id = String(orderId || '').trim();
  if (!id) {
    return {
      orderId: orderId || '',
      success: false,
      updated: false,
      skipped: true,
      code: 'ORDER_ID_REQUIRED',
      message: 'orderId is required',
    };
  }

  const order = await Order.findOne({ orderId: id });
  if (!order) {
    return {
      orderId: id,
      success: false,
      updated: false,
      skipped: true,
      code: 'ORDER_NOT_FOUND',
      message: 'Order not found',
    };
  }

  if (!hasShiprocketReference(order.shipmentInfo)) {
    return {
      orderId: id,
      success: false,
      updated: false,
      skipped: true,
      code: 'SHIPROCKET_ORDER_MISSING',
      message: 'No Shiprocket reference on order',
    };
  }

  const previousStatus = String(order.orderStatus || '').toLowerCase();
  if (!isActiveForwardSyncOrderStatus(previousStatus)) {
    return {
      orderId: id,
      success: false,
      updated: false,
      skipped: true,
      code: 'NOT_ELIGIBLE',
      message: 'Order status is not eligible for auto sync',
    };
  }

  const reconcileResult = await reconcileOrderFromShiprocket(order, {
    source: 'admin_auto_sync',
    mode: 'full',
    allowOrderStatusUpdate: true,
  });

  if (!reconcileResult.success) {
    return {
      orderId: id,
      success: false,
      updated: false,
      skipped: false,
      code: reconcileResult.code || 'SYNC_FAILED',
      message: reconcileResult.message || 'Sync failed',
    };
  }

  const fresh = await Order.findOne({ orderId: id }).select('orderStatus').lean();
  const currentStatus = String(fresh?.orderStatus || '').toLowerCase();

  return {
    orderId: id,
    success: true,
    updated: currentStatus !== previousStatus,
    skipped: false,
    previousStatus,
    currentStatus,
  };
}

/**
 * Sync all stale in-range orders from Shiprocket into our DB (loops until queue empty or time budget).
 * @param {{
 *   from: Date,
 *   to: Date,
 *   scopeMatch?: object,
 *   staleMs?: number,
 *   concurrency?: number,
 *   maxRunMs?: number,
 * }} options
 */
async function autoSyncStaleOrdersInRange(options) {
  const concurrency = Math.min(
    8,
    Math.max(1, Number(options.concurrency) || DEFAULT_CONCURRENCY)
  );
  const maxRunMs = Math.min(
    180_000,
    Math.max(10_000, Number(options.maxRunMs) || DEFAULT_MAX_RUN_MS)
  );
  const fetchChunk = Math.max(concurrency, concurrency * FETCH_CHUNK_MULTIPLIER);
  const filterOpts = {
    from: options.from,
    to: options.to,
    scopeMatch: options.scopeMatch,
    staleMs: options.staleMs,
  };

  const startedAt = Date.now();
  const allResults = [];
  let rounds = 0;

  while (Date.now() - startedAt < maxRunMs) {
    const filter = buildAutoSyncCandidateFilter(filterOpts);
    const candidates = await Order.find(filter)
      .sort({ 'shipmentInfo.lastSyncAt': 1, createdAt: -1 })
      .limit(fetchChunk)
      .select('orderId')
      .lean();

    if (!candidates.length) break;

    const orderIds = candidates.map((d) => d.orderId).filter(Boolean);
    const batchResults = await mapInConcurrentWindows(orderIds, concurrency, runAutoSyncSingle);
    allResults.push(...batchResults);
    rounds += 1;

    const syncedThisRound = batchResults.filter((r) => r.success).length;
    if (syncedThisRound === 0) {
      break;
    }
  }

  const remainingStale = await Order.countDocuments(buildAutoSyncCandidateFilter(filterOpts));
  const synced = allResults.filter((r) => r.success);
  const updated = allResults.filter((r) => r.success && r.updated);
  const failed = allResults.filter((r) => !r.success && !r.skipped);
  const skipped = allResults.filter((r) => r.skipped);

  return {
    summary: {
      attempted: allResults.length,
      synced: synced.length,
      updated: updated.length,
      failed: failed.length,
      skipped: skipped.length,
      remainingStale,
      complete: remainingStale === 0,
      rounds,
      timedOut: remainingStale > 0 && Date.now() - startedAt >= maxRunMs,
    },
    results: allResults,
  };
}

module.exports = {
  autoSyncStaleOrdersInRange,
  buildAutoSyncCandidateFilter,
  hasShiprocketReference,
};
