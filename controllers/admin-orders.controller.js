/**
 * Admin / order_manager — read-only dashboard & order list for operations UI.
 */
const Order = require('../models/Order');
const logger = require('../utils/logger');
const {
  resolveDateRange,
  buildSearchFilter,
  buildBucketMatch,
  mergeFilters,
  aggregateSummary,
  mapOrderRow
} = require('../services/adminOrderDashboard.service');
const { autoSyncStaleOrdersInRange } = require('../services/adminOrderAutoSync.service');

function sendError(res, err, fallbackMessage) {
  const status = err.statusCode && Number.isFinite(err.statusCode) ? err.statusCode : 500;
  const code = err.code || (status === 400 ? 'BAD_REQUEST' : 'INTERNAL_ERROR');
  const message = status === 500 && process.env.NODE_ENV === 'production' ? fallbackMessage : err.message;
  if (status >= 500) {
    logger.error('[admin-orders]', { message: err.message, code, stack: err.stack });
  }
  return res.status(status).json({
    success: false,
    code,
    message: message || fallbackMessage
  });
}

/**
 * GET /api/admin/orders/summary
 * Query: from, to (ISO), presetDays (default 30 if no from/to), preset=30d alias
 */
exports.getDashboardSummary = async (req, res) => {
  try {
    let presetDays = req.query.presetDays;
    if (presetDays == null && String(req.query.preset || '').toLowerCase() === '30d') {
      presetDays = 30;
    }

    const rangePreset = req.query.rangePreset || req.query.range;

    const range = resolveDateRange({
      from: req.query.from,
      to: req.query.to,
      presetDays,
      rangePreset
    });

    const scopeMatch = req.adminScope?.orderMatch || {};
    const summary = await aggregateSummary(range.from, range.to, scopeMatch);

    return res.json({
      success: true,
      data: {
        dateRange: {
          from: range.from.toISOString(),
          to: range.to.toISOString(),
          preset: range.presetLabel
        },
        scope: req.adminScope?.storefront || 'ecomm',
        totals: {
          totalOrders: summary.totalOrders,
          /** Gross merchandise value in period (excludes cancelled & payment_failed). */
          totalRevenueInr: summary.totalRevenueInr,
          totalPendingOrders: summary.totalPendingOrders,
          totalCompletedOrders: summary.totalCompletedOrders
        },
        countsByBucket: summary.countsByBucket
      }
    });
  } catch (err) {
    return sendError(res, err, 'Could not load order summary');
  }
};

/**
 * GET /api/admin/orders
 * Query: from, to, presetDays, bucket, search, page, limit, sortBy, sortOrder
 */
exports.getOrdersList = async (req, res) => {
  try {
    let presetDays = req.query.presetDays;
    if (presetDays == null && String(req.query.preset || '').toLowerCase() === '30d') {
      presetDays = 30;
    }

    const rangePreset = req.query.rangePreset || req.query.range;

    const range = resolveDateRange({
      from: req.query.from,
      to: req.query.to,
      presetDays,
      rangePreset
    });

    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '20'), 10) || 20));
    const skip = (page - 1) * limit;

    const sortBy = ['createdAt', 'totalAmount', 'orderStatus'].includes(String(req.query.sortBy))
      ? String(req.query.sortBy)
      : 'createdAt';
    const sortOrder = String(req.query.sortOrder || 'desc').toLowerCase() === 'asc' ? 1 : -1;
    const sort = { [sortBy]: sortOrder };

    const dateMatch = { createdAt: { $gte: range.from, $lte: range.to } };
    const scopeMatch = req.adminScope?.orderMatch || {};
    const search = buildSearchFilter(req.query.search);
    /** Global search: skip status bucket so order ID / phone matches any tab (incl. cancelled). */
    const bucket = search ? {} : buildBucketMatch(req.query.bucket);
    const filter = mergeFilters(
      Object.keys(scopeMatch).length ? { $and: [dateMatch, scopeMatch] } : dateMatch,
      search,
      bucket
    );

    const [orders, total] = await Promise.all([
      Order.find(filter).sort(sort).skip(skip).limit(limit).lean(),
      Order.countDocuments(filter)
    ]);

    const { computeOpsState } = require('../services/shipmentOps/computeOpsState');
    const { OPS_STATES } = require('../services/shipmentOps/constants');
    const { evaluateAndPersistShipmentOps } = require('../services/shipmentOps');
    const { backfillShiprocketPickupIdsForListPage } = require('../services/shiprocketReconcile.service');
    const { repairOrderStatusForShiprocketRto } = require('../constants/rtoOrderQuery');

    for (const doc of orders) {
      const st = String(doc.orderStatus || '').toLowerCase();
      const hasAwb = Boolean(doc.shipmentInfo?.awbCode || doc.shipmentInfo?.trackingNumber);
      if (!hasAwb && ['processing', 'shipped', 'out_for_delivery'].includes(st)) {
        if (computeOpsState(doc) === OPS_STATES.PROVIDER_RESET) {
          const live = await Order.findById(doc._id);
          if (live) {
            await evaluateAndPersistShipmentOps(live, { source: 'admin_list_reship_repair' });
            doc.orderStatus = live.orderStatus;
            doc.shipmentInfo = live.shipmentInfo;
            doc.shipmentOps = live.shipmentOps;
          }
        }
      }
    }

    const rtoRepairIds = orders.filter((doc) => repairOrderStatusForShiprocketRto(doc)).map((doc) => doc._id);
    if (rtoRepairIds.length) {
      await Order.updateMany({ _id: { $in: rtoRepairIds } }, { $set: { orderStatus: 'rto' } });
    }

    await backfillShiprocketPickupIdsForListPage(orders, { max: 20 });

    const rows = orders.map((doc) => mapOrderRow(doc));

    return res.json({
      success: true,
      data: {
        dateRange: {
          from: range.from.toISOString(),
          to: range.to.toISOString(),
          preset: range.presetLabel
        },
        scope: req.adminScope?.storefront || 'ecomm',
        orders: rows,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit) || 0,
          hasNextPage: page * limit < total,
          hasPrevPage: page > 1
        },
        filters: {
          bucket: String(req.query.bucket || 'all').toLowerCase(),
          search: req.query.search ? String(req.query.search).trim() : null
        }
      }
    });
  } catch (err) {
    return sendError(res, err, 'Could not load orders');
  }
};

/**
 * POST /api/admin/orders/auto-sync-statuses
 * Background sync: reconcile all stale in-range orders from Shiprocket → DB (admin Orders tab).
 * Query: from, to, rangePreset, presetDays — same as summary/list; optional staleMinutes, concurrency, maxRunMs
 */
exports.autoSyncOrderStatuses = async (req, res) => {
  try {
    let presetDays = req.query.presetDays;
    if (presetDays == null && String(req.query.preset || '').toLowerCase() === '30d') {
      presetDays = 30;
    }

    const rangePreset = req.query.rangePreset || req.query.range;

    const range = resolveDateRange({
      from: req.query.from,
      to: req.query.to,
      presetDays,
      rangePreset
    });

    const scopeMatch = req.adminScope?.orderMatch || {};
    const staleMinutes = Math.min(
      120,
      Math.max(1, parseInt(String(req.query.staleMinutes || '5'), 10) || 5)
    );
    const concurrency = Math.min(
      8,
      Math.max(1, parseInt(String(req.query.concurrency || '4'), 10) || 4)
    );
    const maxRunMs = Math.min(
      180_000,
      Math.max(10_000, parseInt(String(req.query.maxRunMs || '120000'), 10) || 120_000)
    );

    const syncResult = await autoSyncStaleOrdersInRange({
      from: range.from,
      to: range.to,
      scopeMatch,
      staleMs: staleMinutes * 60 * 1000,
      concurrency,
      maxRunMs
    });

    return res.json({
      success: true,
      data: {
        dateRange: {
          from: range.from.toISOString(),
          to: range.to.toISOString(),
          preset: range.presetLabel
        },
        scope: req.adminScope?.storefront || 'ecomm',
        summary: syncResult.summary,
        results: syncResult.results
      }
    });
  } catch (err) {
    return sendError(res, err, 'Could not auto-sync order statuses');
  }
};
