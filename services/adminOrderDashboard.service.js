/**
 * Query builders & date helpers for admin order dashboard (read-only).
 */
const mongoose = require('mongoose');
const Order = require('../models/Order');
const {
  BUCKET_TO_ORDER_STATUSES,
  PIPELINE_ORDER_STATUSES,
  GMV_EXCLUDED_ORDER_STATUSES,
  fulfillmentBucketKeyFromOrderStatus,
  fulfillmentLabelFromOrderStatus,
  paymentLabelForUi
} = require('../constants/adminOrderFulfillmentBuckets');

const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000;
const DEFAULT_RANGE_DAYS = 30;

/**
 * @param {string | undefined} s
 */
function escapeRegex(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {{ from?: string, to?: string, presetDays?: string | number, rangePreset?: string }} q
 * @returns {{ from: Date, to: Date, presetLabel: string }}
 *
 * Precedence: (1) both `from` & `to` ISO → custom window
 * (2) `rangePreset`: today | last7 | last30
 * (3) `presetDays` rolling window (legacy)
 * (4) default last 30 days rolling
 *
 * `today` = start→end of **server local** calendar day (set TZ=Asia/Kolkata in production if needed).
 */
function resolveDateRange(q) {
  const now = new Date();
  const hasFrom = q.from != null && String(q.from).trim() !== '';
  const hasTo = q.to != null && String(q.to).trim() !== '';

  if (hasFrom !== hasTo) {
    const err = new Error('Both `from` and `to` are required for a custom range');
    err.statusCode = 400;
    err.code = 'INVALID_DATE_RANGE';
    throw err;
  }

  if (hasFrom && hasTo) {
    const from = new Date(q.from);
    const to = new Date(q.to);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      const err = new Error('Invalid `from` or `to` date');
      err.statusCode = 400;
      err.code = 'INVALID_DATE';
      throw err;
    }
    if (from.getTime() > to.getTime()) {
      const err = new Error('`from` must be before or equal to `to`');
      err.statusCode = 400;
      err.code = 'INVALID_DATE_RANGE';
      throw err;
    }
    if (to.getTime() - from.getTime() > MAX_RANGE_MS) {
      const err = new Error('Date range cannot exceed 366 days');
      err.statusCode = 400;
      err.code = 'DATE_RANGE_TOO_LARGE';
      throw err;
    }
    return { from, to, presetLabel: 'custom' };
  }

  const rp = String(q.rangePreset || '').toLowerCase();

  if (rp === 'today') {
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const to = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    return { from, to, presetLabel: 'today' };
  }

  if (rp === 'last7' || rp === 'last_7') {
    const from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    return { from, to: now, presetLabel: '7d' };
  }

  if (rp === 'last30' || rp === 'last_30') {
    const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    return { from, to: now, presetLabel: '30d' };
  }

  if (q.presetDays != null && q.presetDays !== '') {
    const days = Math.min(366, Math.max(1, Number(q.presetDays) || DEFAULT_RANGE_DAYS));
    const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    return { from, to: now, presetLabel: `${days}d` };
  }

  const from = new Date(now.getTime() - DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000);
  return { from, to: now, presetLabel: `${DEFAULT_RANGE_DAYS}d` };
}

/**
 * @param {string | undefined} search
 * @returns {object | null}
 */
function buildSearchFilter(search) {
  const raw = String(search || '').trim();
  if (!raw) return null;
  const safe = escapeRegex(raw);
  const digits = raw.replace(/\D/g, '');
  const or = [{ orderId: { $regex: safe, $options: 'i' } }];
  if (digits.length >= 4) {
    or.push({ 'addressSnapshot.phone': { $regex: escapeRegex(digits), $options: 'i' } });
  }
  return { $or: or };
}

/**
 * @param {string | undefined} bucket
 */
function buildBucketMatch(bucket) {
  const b = String(bucket || 'all').toLowerCase();
  if (b === 'all') return {};
  const statuses = BUCKET_TO_ORDER_STATUSES[/** @type {keyof typeof BUCKET_TO_ORDER_STATUSES} */ (b)];
  if (!statuses) {
    const err = new Error(`Invalid bucket: ${bucket}`);
    err.statusCode = 400;
    err.code = 'INVALID_BUCKET';
    throw err;
  }
  return { orderStatus: { $in: statuses } };
}

/**
 * @param {import('mongoose').FilterQuery<any>} base
 * @param {import('mongoose').FilterQuery<any> | null} search
 * @param {import('mongoose').FilterQuery<any>} bucket
 */
function mergeFilters(base, search, bucket) {
  const parts = [base];
  if (search) parts.push(search);
  if (bucket && Object.keys(bucket).length) parts.push(bucket);
  if (parts.length === 1) return base;
  return { $and: parts };
}

/**
 * @param {Date} from
 * @param {Date} to
 * @param {import('mongoose').FilterQuery<any>} [scopeMatch]
 */
async function aggregateSummary(from, to, scopeMatch = {}) {
  const dateMatch = { createdAt: { $gte: from, $lte: to } };
  const baseMatch =
    scopeMatch && Object.keys(scopeMatch).length
      ? { $and: [dateMatch, scopeMatch] }
      : dateMatch;

  const [row] = await Order.aggregate([
    { $match: baseMatch },
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: null,
              totalOrders: { $sum: 1 },
              totalCompletedOrders: {
                $sum: { $cond: [{ $eq: ['$orderStatus', 'delivered'] }, 1, 0] }
              },
              totalPendingOrders: {
                $sum: {
                  $cond: [{ $in: ['$orderStatus', PIPELINE_ORDER_STATUSES] }, 1, 0]
                }
              },
              totalRevenueInr: {
                $sum: {
                  $cond: [
                    { $not: { $in: ['$orderStatus', GMV_EXCLUDED_ORDER_STATUSES] } },
                    '$totalAmount',
                    0
                  ]
                }
              }
            }
          }
        ],
        byStatus: [{ $group: { _id: '$orderStatus', count: { $sum: 1 } } }]
      }
    }
  ]).exec();

  const t = row?.totals?.[0] || {};
  const byStatus = Object.fromEntries((row?.byStatus || []).map((x) => [x._id, x.count]));

  const countsByBucket = {
    all: t.totalOrders || 0,
    new: byStatus.pending || 0,
    bill_sent: byStatus.confirmed || 0,
    ready_to_pick: byStatus.processing || 0,
    in_transit: (byStatus.shipped || 0) + (byStatus.out_for_delivery || 0),
    completed: byStatus.delivered || 0,
    others:
      (byStatus.cancelled || 0) +
      (byStatus.return_requested || 0) +
      (byStatus.payment_failed || 0)
  };

  return {
    totalOrders: t.totalOrders || 0,
    totalRevenueInr: roundMoney(t.totalRevenueInr || 0),
    totalPendingOrders: t.totalPendingOrders || 0,
    totalCompletedOrders: t.totalCompletedOrders || 0,
    countsByBucket
  };
}

function roundMoney(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function normalizeFinancialView(o) {
  const orderStatus = String(o?.orderStatus || '').toLowerCase();
  const paymentStatus = String(o?.paymentStatus || '').toLowerCase();
  const amountPaidInr = roundMoney(Number(o?.amountPaidInr) || 0);
  const balanceDueInrRaw = roundMoney(Number(o?.balanceDueInr) || 0);
  const isTerminal = ['cancelled', 'payment_failed'].includes(orderStatus) || paymentStatus === 'failed';
  if (isTerminal && amountPaidInr <= 0.01) {
    return { amountPaidInr: 0, balanceDueInr: 0 };
  }
  return { amountPaidInr, balanceDueInr: balanceDueInrRaw };
}

/**
 * @param {import('mongoose').Document | object} order
 */
function mapOrderRow(order) {
  const o = order && typeof order.toObject === 'function' ? order.toObject() : order;
  const phone =
    o.addressSnapshot?.phone ||
    o.addressSnapshot?.mobile ||
    o.addressSnapshot?.phoneNumber ||
    '';
  const itemCount = Array.isArray(o.items) ? o.items.length : 0;
  const bucketKey = fulfillmentBucketKeyFromOrderStatus(o.orderStatus);
  const financials = normalizeFinancialView(o);
  
        
  return {
    orderId: o.orderId,
    orderIdDisplay: `#${String(o.orderId).replace(/^#/, '')}`,
    userId: o.userId,
    contactPhone: String(phone).replace(/\D/g, '').slice(-10) || null,
    createdAt: o.createdAt,
    amountInr: roundMoney(Number(o.totalAmount) || 0),
    currency: 'INR',
    orderStatus: o.orderStatus,
    fulfillmentLabel: fulfillmentLabelFromOrderStatus(o.orderStatus),
    fulfillmentBucket: bucketKey,
    itemCount,
    paymentStatus: o.paymentStatus,
    paymentLabel: paymentLabelForUi(o.paymentStatus),
    balanceDueInr: financials.balanceDueInr,
    amountPaidInr: financials.amountPaidInr
  };
}

module.exports = {
  resolveDateRange,
  buildSearchFilter,
  buildBucketMatch,
  mergeFilters,
  aggregateSummary,
  mapOrderRow,
  roundMoney,
  MAX_RANGE_MS,
  DEFAULT_RANGE_DAYS
};
