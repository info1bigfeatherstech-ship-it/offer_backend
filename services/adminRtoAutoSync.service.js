/**
 * Background Shiprocket → DB sync for admin RTO bucket only.
 * Does not touch forward Orders auto-sync (ACTIVE_FORWARD_SYNC_STATUSES).
 * Stops syncing once providerStatus is warehouse-delivered (refund gate already open).
 */
const Order = require('../models/Order');
const { buildRtoBucketMatch } = require('../constants/rtoOrderQuery');
const {
  isRtoWarehouseDeliveredForOrder,
  ensureRtoWarehouseDeliveredLatch,
  RTO_WAREHOUSE_DELIVERED_REGEX,
} = require('./rtoRefund.service');
const { reconcileOrderFromShiprocket } = require('./shiprocketReconcile.service');
const { hasShiprocketReference } = require('./adminOrderAutoSync.service');

const DEFAULT_STALE_MS = 15 * 60 * 1000;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_MAX_RUN_MS = 90 * 1000;
const FETCH_CHUNK_MULTIPLIER = 5;

/** Admin refund workflow terminals — no need to keep pulling Shiprocket. */
const TERMINAL_RTO_ADMIN_STATUSES = Object.freeze(['refunded', 'closed', 'refund_rejected']);

/**
 * @param {{ from?: Date, to?: Date, scopeMatch?: object, staleMs?: number }} opts
 */
function buildRtoAutoSyncCandidateFilter(opts = {}) {
  const staleMs = Number.isFinite(Number(opts.staleMs)) ? Number(opts.staleMs) : DEFAULT_STALE_MS;
  const cutoff = new Date(Date.now() - staleMs);

  const andParts = [buildRtoBucketMatch()];

  if (opts.from instanceof Date && opts.to instanceof Date) {
    andParts.push({ createdAt: { $gte: opts.from, $lte: opts.to } });
  }

  if (opts.scopeMatch && Object.keys(opts.scopeMatch).length) {
    andParts.push(opts.scopeMatch);
  }

  andParts.push({
    $or: [
      { 'shipmentInfo.shiprocketOrderId': { $exists: true, $nin: [null, ''] } },
      { 'shipmentInfo.shipmentId': { $exists: true, $nin: [null, ''] } },
      { 'shipmentInfo.awbCode': { $exists: true, $nin: [null, ''] } },
      { 'shipmentInfo.trackingNumber': { $exists: true, $nin: [null, ''] } },
    ],
  });

  andParts.push({
    $or: [
      { 'shipmentInfo.lastSyncAt': { $exists: false } },
      { 'shipmentInfo.lastSyncAt': null },
      { 'shipmentInfo.lastSyncAt': { $lt: cutoff } },
    ],
  });

  // Still in transit / initiated — not yet warehouse-delivered (or latched).
  andParts.push({
    $and: [
      {
        $or: [
          { 'returnInfo.rtoWarehouseDeliveredAt': { $exists: false } },
          { 'returnInfo.rtoWarehouseDeliveredAt': null },
        ],
      },
      {
        $or: [
          { 'shipmentInfo.providerStatus': { $exists: false } },
          { 'shipmentInfo.providerStatus': null },
          { 'shipmentInfo.providerStatus': '' },
          {
            'shipmentInfo.providerStatus': {
              $not: { $regex: RTO_WAREHOUSE_DELIVERED_REGEX, $options: 'i' },
            },
          },
        ],
      },
    ],
  });

  // Skip closed refund workflow cases.
  andParts.push({
    $or: [
      { 'returnInfo.rtoStatus': { $exists: false } },
      { 'returnInfo.rtoStatus': null },
      { 'returnInfo.rtoStatus': { $nin: [...TERMINAL_RTO_ADMIN_STATUSES] } },
    ],
  });

  return { $and: andParts };
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
 * @param {string} [source='admin_rto_auto_sync']
 */
async function runRtoAutoSyncSingle(orderId, source = 'admin_rto_auto_sync') {
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

  const adminRtoStatus = String(order.returnInfo?.rtoStatus || '').toLowerCase();
  if (TERMINAL_RTO_ADMIN_STATUSES.includes(adminRtoStatus)) {
    return {
      orderId: id,
      success: false,
      updated: false,
      skipped: true,
      code: 'RTO_TERMINAL',
      message: 'RTO admin status is terminal',
    };
  }

  if (isRtoWarehouseDeliveredForOrder(order)) {
    if (ensureRtoWarehouseDeliveredLatch(order)) {
      try {
        await order.save();
      } catch (_) {
        /* non-blocking */
      }
    }
    return {
      orderId: id,
      success: false,
      updated: false,
      skipped: true,
      code: 'ALREADY_WAREHOUSE_DELIVERED',
      message: 'Already RTO delivered to warehouse',
    };
  }

  const previousProviderStatus = String(order.shipmentInfo?.providerStatus || '');
  const previousOrderStatus = String(order.orderStatus || '').toLowerCase();

  const reconcileResult = await reconcileOrderFromShiprocket(order, {
    source,
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

  const fresh = await Order.findOne({ orderId: id });
  if (fresh && ensureRtoWarehouseDeliveredLatch(fresh)) {
    try {
      await fresh.save();
    } catch (_) {
      /* non-blocking latch */
    }
  }

  const currentProviderStatus = String(fresh?.shipmentInfo?.providerStatus || '');
  const currentOrderStatus = String(fresh?.orderStatus || '').toLowerCase();

  return {
    orderId: id,
    success: true,
    updated:
      currentProviderStatus !== previousProviderStatus ||
      currentOrderStatus !== previousOrderStatus,
    skipped: false,
    previousProviderStatus,
    currentProviderStatus,
    previousOrderStatus,
    currentOrderStatus,
    warehouseDelivered: isRtoWarehouseDeliveredForOrder(fresh || { shipmentInfo: { providerStatus: currentProviderStatus } }),
  };
}

/**
 * Sync stale non-warehouse-delivered RTO orders from Shiprocket into Mongo.
 * @param {{
 *   from?: Date,
 *   to?: Date,
 *   scopeMatch?: object,
 *   staleMs?: number,
 *   concurrency?: number,
 *   maxRunMs?: number,
 *   source?: string,
 * }} options
 */
async function autoSyncStaleRtoOrdersInRange(options = {}) {
  const concurrency = Math.min(
    6,
    Math.max(1, Number(options.concurrency) || DEFAULT_CONCURRENCY)
  );
  const maxRunMs = Math.min(
    180_000,
    Math.max(10_000, Number(options.maxRunMs) || DEFAULT_MAX_RUN_MS)
  );
  const fetchChunk = Math.max(concurrency, concurrency * FETCH_CHUNK_MULTIPLIER);
  const source = String(options.source || 'admin_rto_auto_sync').trim() || 'admin_rto_auto_sync';
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
    const filter = buildRtoAutoSyncCandidateFilter(filterOpts);
    const candidates = await Order.find(filter)
      .sort({ 'shipmentInfo.lastSyncAt': 1, createdAt: -1 })
      .limit(fetchChunk)
      .select('orderId')
      .lean();

    if (!candidates.length) break;

    const orderIds = candidates.map((d) => d.orderId).filter(Boolean);
    const batchResults = await mapInConcurrentWindows(orderIds, concurrency, (id) =>
      runRtoAutoSyncSingle(id, source)
    );
    allResults.push(...batchResults);
    rounds += 1;

    const syncedThisRound = batchResults.filter((r) => r.success).length;
    if (syncedThisRound === 0) break;
  }

  const remainingStale = await Order.countDocuments(buildRtoAutoSyncCandidateFilter(filterOpts));
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
  autoSyncStaleRtoOrdersInRange,
  buildRtoAutoSyncCandidateFilter,
  runRtoAutoSyncSingle,
  TERMINAL_RTO_ADMIN_STATUSES,
};
