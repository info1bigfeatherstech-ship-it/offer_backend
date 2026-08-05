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
  fulfillmentLabelForAdminListRow,
  paymentLabelForUi
} = require('../constants/adminOrderFulfillmentBuckets');
const {
  buildRtoBucketMatch,
  buildRtoExclusionForNonRtoBucket,
  repairOrderStatusForShiprocketRto,
  repairOrderStatusForFalseDeliveredNdr,
  isRtoProviderStatus,
  NDR_UNDELIVERED_PROVIDER_STATUS_REGEX
} = require('../constants/rtoOrderQuery');
const {
  buildPickupExceptionBucketMatch,
  buildPickupExceptionExclusionForNonExceptionBucket,
  isPickupExceptionAdminBucketOrder
} = require('../constants/pickupExceptionOrderQuery');
const { evaluateOrderPaymentForShiprocketFulfillment } = require('../utils/orderFulfillmentPaymentGate');
const { buildListRowFulfillmentUi } = require('../utils/adminOrderListFulfillmentUi');
const { resolveOrderShippingProvider } = require('../constants/shippingProviders');

const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000;
const DEFAULT_RANGE_DAYS = 30;

/** Cancelled-tab statuses — excluded from All tab list and total order count. */
const ALL_TAB_EXCLUDED_ORDER_STATUSES = BUCKET_TO_ORDER_STATUSES.others;

/**
 * @param {string | undefined} s
 */
function escapeRegex(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {{ from?: string, to?: string, presetDays?: string | number, rangePreset?: string }} q
 * @returns {{ from: Date | null, to: Date | null, presetLabel: string }}
 *
 * Precedence: (1) both `from` & `to` ISO → custom window
 * (2) `rangePreset`: all | today | last7 | last30
 * (3) `presetDays` rolling window (legacy)
 * (4) default last 30 days rolling
 *
 * `all` = no createdAt window (dashboard cards / lifetime totals).
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

  if (rp === 'all' || rp === 'alltime' || rp === 'lifetime') {
    return { from: null, to: null, presetLabel: 'all' };
  }

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
 * @param {Date | null | undefined} from
 * @param {Date | null | undefined} to
 * @param {import('mongoose').FilterQuery<any>} [scopeMatch]
 */
function buildScopedDateMatch(from, to, scopeMatch = {}) {
  const clauses = [];
  if (from instanceof Date && to instanceof Date && !Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime())) {
    clauses.push({ createdAt: { $gte: from, $lte: to } });
  }
  if (scopeMatch && Object.keys(scopeMatch).length) {
    clauses.push(scopeMatch);
  }
  if (clauses.length === 0) return {};
  if (clauses.length === 1) return clauses[0];
  return { $and: clauses };
}

/**
 * @param {string | undefined} search
 * @returns {object | null}
 */
async function buildSearchFilter(search) {
  const raw = String(search || '').trim();
  if (!raw) return null;
  const safe = escapeRegex(raw);
  const digits = raw.replace(/\D/g, '');

  let matchedProductIds = [];
  try {
    const Product = require('../models/Product');
    const matchedProducts = await Product.find(
      { 'variants.sku': { $regex: safe, $options: 'i' } },
      '_id'
    ).lean();
    if (matchedProducts && matchedProducts.length > 0) {
      matchedProductIds = matchedProducts.map((p) => p._id);
    }
  } catch (err) {
    const logger = require('../utils/logger');
    logger.error('Failed to search product SKUs for search filter', err);
  }

  const or = [
    { orderId: { $regex: safe, $options: 'i' } },
    { 'shipmentInfo.shiprocketOrderId': { $regex: safe, $options: 'i' } },
    { 'shipmentInfo.shiprocketPickupId': { $regex: safe, $options: 'i' } },
    { 'shipmentInfo.awbCode': { $regex: safe, $options: 'i' } },
    { 'shipmentInfo.trackingNumber': { $regex: safe, $options: 'i' } },
    { 'addressSnapshot.fullName': { $regex: safe, $options: 'i' } },
    { 'addressSnapshot.name': { $regex: safe, $options: 'i' } },
    { 'addressSnapshot.firstName': { $regex: safe, $options: 'i' } },
    { 'addressSnapshot.lastName': { $regex: safe, $options: 'i' } },
    { 'shippingWeightSnapshot.lines.sku': { $regex: safe, $options: 'i' } }
  ];

  if (matchedProductIds.length > 0) {
    or.push({ 'items.productId': { $in: matchedProductIds } });
  }

  if (digits.length >= 4) {
    const digitsSafe = escapeRegex(digits);
    or.push(
      { 'addressSnapshot.phone': { $regex: digitsSafe, $options: 'i' } },
      { 'addressSnapshot.mobile': { $regex: digitsSafe, $options: 'i' } },
      { 'addressSnapshot.phoneNumber': { $regex: digitsSafe, $options: 'i' } }
    );
  }
  return { $or: or };
}

/**
 * Compose Mongo `$and` from non-null filter parts.
 * @param {...(import('mongoose').FilterQuery<any>|null|undefined)} parts
 * @returns {import('mongoose').FilterQuery<any>}
 */
function andFilters(...parts) {
  const filtered = parts.filter((p) => p && typeof p === 'object' && Object.keys(p).length > 0);
  if (filtered.length === 0) return {};
  if (filtered.length === 1) return filtered[0];
  return { $and: filtered };
}

/**
 * @param {string | undefined} bucket
 */
function buildBucketMatch(bucket) {
  const b = String(bucket || 'all').toLowerCase();
  if (b === 'all') {
    return { orderStatus: { $nin: ALL_TAB_EXCLUDED_ORDER_STATUSES } };
  }
  if (b === 'rto') {
    return buildRtoBucketMatch();
  }
  if (b === 'pickup_exception') {
    return buildPickupExceptionBucketMatch();
  }
  if (b === 'in_transit') {
    const ndrProviderMatch = { $regex: NDR_UNDELIVERED_PROVIDER_STATUS_REGEX, $options: 'i' };
    return andFilters(
      {
        $or: [
          { orderStatus: { $in: ['shipped', 'out_for_delivery'] } },
          { orderStatus: 'delivered', 'shipmentInfo.providerStatus': ndrProviderMatch }
        ]
      },
      buildRtoExclusionForNonRtoBucket(b),
      buildPickupExceptionExclusionForNonExceptionBucket(b)
    );
  }
  if (b === 'ready_to_pick') {
    const match = {
      orderStatus: 'processing',
      'shipmentInfo.manifestDownloaded': true,
      'shipmentInfo.labelDownloaded': true
    };
    return andFilters(
      match,
      buildRtoExclusionForNonRtoBucket(b),
      buildPickupExceptionExclusionForNonExceptionBucket(b)
    );
  }
  if (b === 'ready_to_ship') {
    const match = {
      orderStatus: 'processing',
      $or: [
        { 'shipmentInfo.manifestDownloaded': { $ne: true } },
        { 'shipmentInfo.labelDownloaded': { $ne: true } }
      ]
    };
    return andFilters(
      match,
      buildRtoExclusionForNonRtoBucket(b),
      buildPickupExceptionExclusionForNonExceptionBucket(b)
    );
  }
  const statuses = BUCKET_TO_ORDER_STATUSES[/** @type {keyof typeof BUCKET_TO_ORDER_STATUSES} */ (b)];
  if (!statuses) {
    const err = new Error(`Invalid bucket: ${bucket}`);
    err.statusCode = 400;
    err.code = 'INVALID_BUCKET';
    throw err;
  }
  const statusMatch = { orderStatus: { $in: statuses } };
  return andFilters(
    statusMatch,
    buildRtoExclusionForNonRtoBucket(b),
    buildPickupExceptionExclusionForNonExceptionBucket(b)
  );
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
 * @param {Date | null} from
 * @param {Date | null} to
 * @param {import('mongoose').FilterQuery<any>} [scopeMatch]
 */
async function aggregateSummary(from, to, scopeMatch = {}) {
  const baseMatch = buildScopedDateMatch(from, to, scopeMatch);

  const [row] = await Order.aggregate([
    { $match: baseMatch },
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: null,
              totalOrders: {
                $sum: {
                  $cond: [
                    { $not: { $in: ['$orderStatus', ALL_TAB_EXCLUDED_ORDER_STATUSES] } },
                    1,
                    0
                  ]
                }
              },
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
                    {
                      $and: [
                        { $not: { $in: ['$orderStatus', GMV_EXCLUDED_ORDER_STATUSES] } },
                        { $ne: ['$paymentStatus', 'failed'] }
                      ]
                    },
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

  const { RTO_PROVIDER_STATUS_REGEX, NDR_UNDELIVERED_PROVIDER_STATUS_REGEX } = require('../constants/rtoOrderQuery');
  const rtoProviderMatch = { $regex: RTO_PROVIDER_STATUS_REGEX, $options: 'i' };
  const ndrProviderMatch = { $regex: NDR_UNDELIVERED_PROVIDER_STATUS_REGEX, $options: 'i' };

  const pickupExceptionExclude = buildPickupExceptionExclusionForNonExceptionBucket('ready_to_ship');
  const confirmedPickupExceptionExclude =
    buildPickupExceptionExclusionForNonExceptionBucket('bill_sent');

  const [
    rtoCount,
    pickupExceptionCount,
    legacyRtoInCancelled,
    legacyRtoInDelivered,
    falseDeliveredNdrCount,
    readyToPickCount,
    readyToShipCount,
    confirmedWithoutPickupExceptionCount
  ] = await Promise.all([
    Order.countDocuments({ $and: [baseMatch, buildRtoBucketMatch()] }),
    Order.countDocuments({ $and: [baseMatch, buildPickupExceptionBucketMatch()] }),
    Order.countDocuments({
      $and: [baseMatch, { orderStatus: 'cancelled', 'shipmentInfo.providerStatus': rtoProviderMatch }]
    }),
    Order.countDocuments({
      $and: [baseMatch, { orderStatus: 'delivered', 'shipmentInfo.providerStatus': rtoProviderMatch }]
    }),
    Order.countDocuments({
      $and: [baseMatch, { orderStatus: 'delivered', 'shipmentInfo.providerStatus': ndrProviderMatch }]
    }),
    Order.countDocuments(
      andFilters(baseMatch, {
        orderStatus: 'processing',
        'shipmentInfo.manifestDownloaded': true,
        'shipmentInfo.labelDownloaded': true
      }, pickupExceptionExclude)
    ),
    Order.countDocuments(
      andFilters(baseMatch, {
        orderStatus: 'processing',
        $or: [
          { 'shipmentInfo.manifestDownloaded': { $ne: true } },
          { 'shipmentInfo.labelDownloaded': { $ne: true } }
        ]
      }, pickupExceptionExclude)
    ),
    Order.countDocuments(
      andFilters(baseMatch, { orderStatus: 'confirmed' }, confirmedPickupExceptionExclude)
    )
  ]);

  const countsByBucket = {
    all: t.totalOrders || 0,
    new: byStatus.pending || 0,
    bill_sent: confirmedWithoutPickupExceptionCount,
    ready_to_ship: readyToShipCount,
    ready_to_pick: readyToPickCount,
    in_transit:
      (byStatus.shipped || 0) + (byStatus.out_for_delivery || 0) + falseDeliveredNdrCount,
    completed:
      Math.max(0, (byStatus.delivered || 0) - legacyRtoInDelivered - falseDeliveredNdrCount) +
      (byStatus.return_requested || 0),
    rto: rtoCount,
    pickup_exception: pickupExceptionCount,
    others:
      Math.max(0, (byStatus.cancelled || 0) - legacyRtoInCancelled) + (byStatus.payment_failed || 0)
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

function formatShiprocketPickupIdDisplay(value) {
  if (value == null || String(value).trim() === '') return null;
  const shiprocket = require('../utils/shiprocket');
  return shiprocket.normalizeShiprocketPickupId(value);
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
  repairOrderStatusForShiprocketRto(o);
  repairOrderStatusForFalseDeliveredNdr(o);
  const phone =
    o.addressSnapshot?.phone ||
    o.addressSnapshot?.mobile ||
    o.addressSnapshot?.phoneNumber ||
    '';
  const itemCount = Array.isArray(o.items) ? o.items.length : 0;
  const si = o.shipmentInfo || {};
  let bucketKey =
    isRtoProviderStatus(si.providerStatus) || o.orderStatus === 'rto'
      ? 'rto'
      : isPickupExceptionAdminBucketOrder(o)
        ? 'pickup_exception'
        : fulfillmentBucketKeyFromOrderStatus(o.orderStatus);
  if (bucketKey === 'ready_to_pick' || bucketKey === 'ready_to_ship') {
    const manifestDownloaded = Boolean(si.manifestDownloaded);
    const labelDownloaded = Boolean(si.labelDownloaded);
    if (manifestDownloaded && labelDownloaded) {
      bucketKey = 'ready_to_pick';
    } else {
      bucketKey = 'ready_to_ship';
    }
  }
  const financials = normalizeFinancialView(o);
  const hasAwb = Boolean(si.awbCode || si.trackingNumber);
  const hasShipmentId = Boolean(si.shipmentId);
  const pickupScheduled = Boolean(si.pickupScheduledAt || si.pickupDate);
  const hasManifest = Boolean(si.manifestUrl);
  const hasLabel = Boolean(si.labelUrl);
  const hasShiprocketOrderId = Boolean(si.shiprocketOrderId);
  const orderStatusLower = String(o.orderStatus || '').toLowerCase();
  const isPending = orderStatusLower === 'pending';
  const fulfillmentPaymentGate = evaluateOrderPaymentForShiprocketFulfillment(o);
  const canConfirmForFulfillment = isPending && fulfillmentPaymentGate.ok === true;

  const rowBase = {
    orderStatus: o.orderStatus,
    hasAwb,
    hasShipmentId,
    hasManifest,
    hasLabel,
    hasShiprocketOrderId,
    pickupScheduled,
    pickupDate: si.pickupDate || null,
    canConfirmForFulfillment,
    shipmentInfo: si,
    fulfillmentPaymentGate: fulfillmentPaymentGate.ok
      ? { ok: true, reason: fulfillmentPaymentGate.reason }
      : {
          ok: false,
          code: fulfillmentPaymentGate.code,
          message: fulfillmentPaymentGate.message
        }
  };
  const fulfillmentUi = buildListRowFulfillmentUi({
    ...o,
    ...rowBase
  });

  return {
    orderId: o.orderId,
    orderIdDisplay: `#${String(o.orderId).replace(/^#/, '')}`,
    userId: o.userId,
    contactPhone: String(phone).replace(/\D/g, '').slice(-10) || null,
    createdAt: o.createdAt,
    amountInr: roundMoney(Number(o.totalAmount) || 0),
    currency: 'INR',
    orderStatus: o.orderStatus,
    shippingProvider: resolveOrderShippingProvider(o),
    fulfillmentLabel: fulfillmentLabelForAdminListRow(o.orderStatus, si.providerStatus, bucketKey),
    fulfillmentBucket: bucketKey,
    itemCount,
    paymentStatus: o.paymentStatus,
    paymentLabel: paymentLabelForUi(o.paymentStatus),
    paymentMethod: o.paymentInfo?.method || null,
    balanceDueInr: financials.balanceDueInr,
    amountPaidInr: financials.amountPaidInr,
    hasAwb,
    hasShipmentId,
    hasManifest,
    hasLabel,
    hasShiprocketOrderId,
    pickupScheduled,
    pickupDate: si.pickupDate || null,
    shiprocketPickupId: si.shiprocketPickupId || null,
    shiprocketPickupIdDisplay: formatShiprocketPickupIdDisplay(si.shiprocketPickupId),
    courier: si.courier || null,
    providerStatus: si.providerStatus || null,
    awbCode: si.awbCode || si.trackingNumber || null,
    manifestDownloaded: Boolean(si.manifestDownloaded),
    labelDownloaded: Boolean(si.labelDownloaded),
    canConfirmForFulfillment,
    courierOpsLine1: fulfillmentUi.courierOpsLine1,
    courierOpsLine2: fulfillmentUi.courierOpsLine2,
    actionCapabilities: fulfillmentUi.actionCapabilities,
    primaryAction: fulfillmentUi.primaryAction,
    primaryActionLabel: fulfillmentUi.primaryActionLabel,
    opsState: fulfillmentUi.opsState || null,
    opsStateLabel: fulfillmentUi.opsStateLabel || null,
    blockReasons: fulfillmentUi.blockReasons || {},
    nextStepMessage: fulfillmentUi.nextStepMessage || null,
    riskFlags: fulfillmentUi.riskFlags || {},
    externalLinks: fulfillmentUi.externalLinks || {},
    syncHealth: fulfillmentUi.syncHealth || 'unknown',
    fulfillmentPaymentGate: rowBase.fulfillmentPaymentGate
  };
}

module.exports = {
  resolveDateRange,
  buildScopedDateMatch,
  buildSearchFilter,
  buildBucketMatch,
  mergeFilters,
  aggregateSummary,
  mapOrderRow,
  roundMoney,
  MAX_RANGE_MS,
  DEFAULT_RANGE_DAYS
};
