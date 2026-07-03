/**
 * Admin RTO management — isolated from Orders tab & order.controller.
 */
const Razorpay = require('razorpay');
const Order = require('../models/Order');
const logger = require('../utils/logger');
const { roundMoney2 } = require('../services/checkoutComputation.service');
const { buildRtoBucketMatch, repairOrderStatusForShiprocketRto } = require('../constants/rtoOrderQuery');
const {
  resolveDateRange,
  buildSearchFilter,
  mapOrderRow
} = require('../services/adminOrderDashboard.service');
const {
  calculateRtoRefund,
  classifyRtoReasonCategory,
  classifyRtoReasonLabel,
  mapShiprocketRtoStage,
  isRtoDeliveredToWarehouse,
  classifyRtoPaymentType,
  deriveRefundTrackStatus,
  syncRtoRefundStatusFromOrder,
  mergeReturnInfo,
  hasRtoRefundBeenInitiated,
  RTO_WAREHOUSE_DELIVERED_REGEX,
  buildCustomerRtoSectionMatch,
  buildCourierRtoSectionMatch
} = require('../services/rtoRefund.service');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

function sendError(res, err, fallbackMessage) {
  const status = err.statusCode && Number.isFinite(err.statusCode) ? err.statusCode : 500;
  const code = err.code || (status === 400 ? 'BAD_REQUEST' : 'INTERNAL_ERROR');
  const message = status === 500 && process.env.NODE_ENV === 'production' ? fallbackMessage : err.message;
  if (status >= 500) {
    logger.error('[admin-rto]', { message: err.message, code, stack: err.stack });
  }
  return res.status(status).json({
    success: false,
    code,
    message: message || fallbackMessage
  });
}

function createHttpError(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

/** Combine multiple MongoDB filter fragments. */
function mergeRtoFilters(...parts) {
  const valid = parts.filter((p) => p && typeof p === 'object' && Object.keys(p).length);
  if (!valid.length) return {};
  if (valid.length === 1) return valid[0];
  return { $and: valid };
}

function appendRtoHistory(order, { action, note, performedBy, metadata }) {
  if (!order.returnInfo) order.returnInfo = {};
  order.returnInfo.rtoHistory = order.returnInfo.rtoHistory || [];
  order.returnInfo.rtoHistory.push({
    action,
    note: note || null,
    performedBy: performedBy || null,
    createdAt: new Date(),
    metadata: metadata || null
  });
  order.markModified('returnInfo');
}

async function applyRtoRefundEntryToOrder(order, refundEntity, adminUserId, calc) {
  if (!order || !refundEntity) return;
  const amountPaise = Number(refundEntity.amount);
  if (!Number.isFinite(amountPaise) || amountPaise <= 0) return;
  const amountInr = roundMoney2(amountPaise / 100);

  const entry = {
    refundId: refundEntity.id,
    amountInr,
    amountPaise,
    status: refundEntity.status || 'processed',
    reason: (refundEntity.notes && refundEntity.notes.reason) || 'rto_refund',
    createdAt: new Date()
  };

  order.refundHistory = order.refundHistory || [];
  if (!order.refundHistory.some((r) => r.refundId === entry.refundId)) {
    order.refundHistory.push(entry);
  }

  const totalRefundedInr = roundMoney2(
    (order.refundHistory || []).reduce((s, r) => s + (Number(r.amountInr) || 0), 0)
  );
  if (totalRefundedInr >= roundMoney2(order.totalAmount)) {
    order.paymentStatus = 'refunded';
  } else if (totalRefundedInr > 0) {
    order.paymentStatus = 'partially_refunded';
  }

  const ri = order.returnInfo || {};
  order.returnInfo = mergeReturnInfo(ri, {
    refundAmount: totalRefundedInr,
    refundId: entry.refundId,
    status: entry.status,
    refundInitiatedAt: ri.refundInitiatedAt || new Date(),
    rtoRefundId: entry.refundId,
    rtoRefundAmount: amountInr,
    rtoDeductions: calc?.deductions || ri.rtoDeductions,
    rtoStatus:
      String(entry.status || '').toLowerCase() === 'failed' ? 'refund_failed' : ri.rtoStatus || 'pending',
    rtoRefundError: null
  });

  const st = String(entry.status || '').toLowerCase();
  if (st === 'processed' || st === 'completed') {
    order.returnInfo.rtoStatus = 'refunded';
    order.returnInfo.rtoRefundedAt = new Date();
  }

  order.markModified('returnInfo');

  appendRtoHistory(order, {
    action: 'refund_initiated',
    note: `Razorpay refund ${entry.refundId} for ₹${amountInr}`,
    performedBy: adminUserId,
    metadata: { refundId: entry.refundId, amountInr, deductions: calc?.deductions }
  });

  await order.save();
}

function buildRtoSectionMatch(section) {
  const key = String(section || 'all').toLowerCase();
  if (key === 'all' || key === 'dashboard') return null;

  if (key === 'customer_related') {
    return buildCustomerRtoSectionMatch();
  }

  if (key === 'courier_related') {
    return buildCourierRtoSectionMatch();
  }

  if (key === 'partial_paid') {
    return {
      'paymentInfo.method': { $ne: 'cod' },
      $or: [
        { paymentStatus: 'partially_paid' },
        {
          paymentStatus: { $ne: 'paid' },
          amountPaidInr: { $gt: 0 },
          $expr: { $lt: [{ $ifNull: ['$amountPaidInr', 0] }, '$totalAmount'] }
        }
      ]
    };
  }

  if (key === 'refund_pending') {
    return {
      paymentStatus: 'paid',
      'paymentInfo.method': { $in: ['online', 'prepaid'] },
      $expr: { $gte: [{ $ifNull: ['$amountPaidInr', 0] }, '$totalAmount'] },
      'returnInfo.rtoStatus': { $in: [null, 'pending'] },
      $and: [
        {
          $or: [
            { 'returnInfo.rtoRefundId': { $exists: false } },
            { 'returnInfo.rtoRefundId': null },
            { 'returnInfo.rtoRefundId': '' }
          ]
        },
        {
          $or: [
            { 'returnInfo.refundInitiatedAt': { $exists: false } },
            { 'returnInfo.refundInitiatedAt': null }
          ]
        }
      ],
      'shipmentInfo.providerStatus': { $regex: RTO_WAREHOUSE_DELIVERED_REGEX, $options: 'i' }
    };
  }
  if (key === 'refund_processed') {
    return {
      $or: [
        { 'returnInfo.rtoRefundId': { $exists: true, $nin: [null, ''] } },
        { 'returnInfo.refundInitiatedAt': { $exists: true, $ne: null } },
        { 'returnInfo.rtoStatus': 'refunded' }
      ],
      'returnInfo.rtoStatus': { $nin: ['refund_failed', 'refund_rejected'] }
    };
  }
  if (key === 'refund_rejected') {
    return { 'returnInfo.rtoStatus': { $in: ['refund_rejected', 'refund_failed'] } };
  }
  if (key === 'resolved') {
    return { 'returnInfo.rtoStatus': 'resolved' };
  }

  return null;
}

function buildRtoStatusFilterMatch(statusFilter) {
  const st = String(statusFilter || '').trim().toLowerCase();
  if (!st || st === 'all') return null;
  if (st === 'pending') return { 'returnInfo.rtoStatus': { $in: [null, 'pending'] } };
  return { 'returnInfo.rtoStatus': st };
}

function mapRtoOrderRow(order) {
  const o = order && typeof order.toObject === 'function' ? order.toObject() : order;
  repairOrderStatusForShiprocketRto(o);
  syncRtoRefundStatusFromOrder(o);

  const base = mapOrderRow(o);
  const ri = o.returnInfo || {};
  const calc = calculateRtoRefund(o);
  const providerStatus = o.shipmentInfo?.providerStatus || null;
  const reasonCategory = classifyRtoReasonCategory(providerStatus);
  const rtoStage = mapShiprocketRtoStage(providerStatus);
  const rtoStatus = ri.rtoStatus || 'pending';
  const refundTrack = deriveRefundTrackStatus(o);
  const warehouseDelivered = isRtoDeliveredToWarehouse(providerStatus);
  const paymentType = classifyRtoPaymentType(o);
  const adminActionRequired = warehouseDelivered && rtoStatus === 'pending' && paymentType.refundAllowed;

  const customerName =
    o.addressSnapshot?.name ||
    o.addressSnapshot?.fullName ||
    [o.addressSnapshot?.firstName, o.addressSnapshot?.lastName].filter(Boolean).join(' ') ||
    '—';

  return {
    ...base,
    customerName,
    subtotalInr: roundMoney2(Number(o.subtotal) || 0),
    deliveryChargesInr: roundMoney2(Number(o.deliveryCharges) || 0),
    rtoStatus,
    rtoStage,
    rtoStageLabel:
      rtoStage === 'rto_in_transit'
        ? 'RTO In Transit'
        : rtoStage === 'rto_delivered_to_warehouse'
          ? 'RTO Delivered to Warehouse'
          : 'RTO Initiated',
    adminActionRequired,
    shiprocketReason: providerStatus,
    rtoReason: classifyRtoReasonLabel(providerStatus),
    rtoReasonCategory: reasonCategory,
    rtoReasonCategoryLabel:
      reasonCategory === 'customer'
        ? 'Customer fault'
        : reasonCategory === 'courier'
          ? 'Courier / logistics'
          : 'Unclassified',
    returnedAt: o.shipmentInfo?.deliveredAt || o.shipmentInfo?.lastSyncAt || o.updatedAt,
    refundCalculation: calc,
    rtoDeductions: ri.rtoDeductions?.platformFee != null ? ri.rtoDeductions : calc.deductions,
    rtoRefundAmount: ri.rtoRefundAmount ?? null,
    rtoRefundId: ri.rtoRefundId || null,
    rtoRefundedAt: ri.rtoRefundedAt || null,
    rtoRejectedAt: ri.rtoRejectedAt || null,
    rtoRejectionNote: ri.rtoRejectionNote || null,
    rtoResolvedAt: ri.rtoResolvedAt || null,
    rtoRefundError: ri.rtoRefundError || null,
    refundTrackStatus: refundTrack,
    paymentType,
    warehouseDelivered,
    canRefund:
      calc.eligible &&
      warehouseDelivered &&
      ['pending', null].includes(rtoStatus) &&
      !ri.rtoRejectedAt &&
      !hasRtoRefundBeenInitiated(o),
    canReject:
      ['pending', null].includes(rtoStatus) &&
      !hasRtoRefundBeenInitiated(o) &&
      !['refunded', 'refund_rejected', 'refund_failed', 'resolved'].includes(rtoStatus),
    refundBlockedReason:
      calc.eligible && !warehouseDelivered
        ? 'Waiting for Shiprocket RTO Delivered to warehouse'
        : !calc.eligible
          ? paymentType.key === 'partial_paid'
            ? 'Partial payment — close case (no Razorpay)'
            : paymentType.key === 'cod'
              ? 'COD — close case (no Razorpay)'
              : null
          : null
  };
}

async function findRtoOrderOrThrow(orderId, scopeMatch = {}) {
  const filter = mergeRtoFilters(buildRtoBucketMatch(), { orderId: String(orderId).trim() }, scopeMatch);
  const order = await Order.findOne(filter);
  if (!order) {
    throw createHttpError(404, 'RTO_ORDER_NOT_FOUND', 'RTO order not found');
  }
  repairOrderStatusForShiprocketRto(order);
  syncRtoRefundStatusFromOrder(order);
  return order;
}

/**
 * GET /api/admin/rto/orders
 */
exports.getRtoOrders = async (req, res) => {
  try {
    const range = resolveDateRange({
      from: req.query.from,
      to: req.query.to,
      presetDays: req.query.presetDays,
      rangePreset: req.query.rangePreset || req.query.range
    });

    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '20'), 10) || 20));
    const skip = (page - 1) * limit;

    const sortBy = ['createdAt', 'totalAmount', 'orderStatus'].includes(String(req.query.sortBy))
      ? String(req.query.sortBy)
      : 'createdAt';
    const sortOrder = String(req.query.sortOrder || 'desc').toLowerCase() === 'asc' ? 1 : -1;
    const sort = { [sortBy]: sortOrder };

    const scopeMatch = req.adminScope?.orderMatch || {};
    const dateMatch = { createdAt: { $gte: range.from, $lte: range.to } };
    const search = buildSearchFilter(req.query.search);
    const sectionMatch = buildRtoSectionMatch(req.query.section);
    const statusMatch = buildRtoStatusFilterMatch(req.query.status);

    const filter = mergeRtoFilters(
      Object.keys(scopeMatch).length ? { $and: [dateMatch, scopeMatch] } : dateMatch,
      buildRtoBucketMatch(),
      search,
      sectionMatch,
      statusMatch
    );

    const [orders, total, statusAgg] = await Promise.all([
      Order.find(filter).sort(sort).skip(skip).limit(limit).lean(),
      Order.countDocuments(filter),
      Order.aggregate([
        { $match: filter },
        {
          $group: {
            _id: { $ifNull: ['$returnInfo.rtoStatus', 'pending'] },
            count: { $sum: 1 }
          }
        }
      ])
    ]);

    const repairIds = [];
    const syncSets = [];
    const pendingInitIds = [];

    for (const doc of orders) {
      if (repairOrderStatusForShiprocketRto(doc)) repairIds.push(doc._id);

      const beforeStatus = doc.returnInfo?.rtoStatus;
      const live = { ...doc, returnInfo: { ...(doc.returnInfo || {}) } };
      if (syncRtoRefundStatusFromOrder(live)) {
        doc.returnInfo = live.returnInfo;
        const $set = {};
        if (live.returnInfo.rtoStatus != null) $set['returnInfo.rtoStatus'] = live.returnInfo.rtoStatus;
        if (live.returnInfo.rtoRefundedAt) $set['returnInfo.rtoRefundedAt'] = live.returnInfo.rtoRefundedAt;
        if (Object.keys($set).length) syncSets.push({ _id: doc._id, $set });
      }

      if (!doc.returnInfo?.rtoStatus) {
        doc.returnInfo = { ...(doc.returnInfo || {}), rtoStatus: 'pending' };
        if (!beforeStatus) pendingInitIds.push(doc._id);
      }
    }

    if (repairIds.length) {
      await Order.updateMany({ _id: { $in: repairIds } }, { $set: { orderStatus: 'rto' } });
    }
    for (const row of syncSets) {
      await Order.updateOne({ _id: row._id }, { $set: row.$set });
    }
    if (pendingInitIds.length) {
      await Order.updateMany(
        { _id: { $in: pendingInitIds }, 'returnInfo.rtoStatus': { $in: [null, ''] } },
        { $set: { 'returnInfo.rtoStatus': 'pending' } }
      );
    }

    const rows = orders.map((doc) => mapRtoOrderRow(doc));

    const summaryCounts = {
      total,
      pending: 0,
      refunded: 0,
      resolved: 0,
      refund_failed: 0,
      refund_rejected: 0
    };
    for (const row of statusAgg) {
      const key = String(row._id || 'pending').toLowerCase();
      if (key === 'refunded') summaryCounts.refunded = row.count;
      else if (key === 'resolved') summaryCounts.resolved = row.count;
      else if (key === 'refund_failed') summaryCounts.refund_failed = row.count;
      else if (key === 'refund_rejected') summaryCounts.refund_rejected = row.count;
      else summaryCounts.pending += row.count;
    }

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
        summaryCounts,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit) || 0,
          hasNextPage: page * limit < total,
          hasPrevPage: page > 1
        },
        filters: {
          section: String(req.query.section || 'all').toLowerCase(),
          status: req.query.status ? String(req.query.status).trim() : null,
          search: req.query.search ? String(req.query.search).trim() : null
        }
      }
    });
  } catch (err) {
    return sendError(res, err, 'Could not load RTO orders');
  }
};

/**
 * POST /api/admin/rto/refund
 */
exports.processRtoRefund = async (req, res) => {
  try {
    const { orderId, rtoShippingOverride } = req.body || {};
    if (!orderId) {
      throw createHttpError(400, 'ORDER_ID_REQUIRED', 'orderId is required');
    }

    const scopeMatch = req.adminScope?.orderMatch || {};
    const order = await findRtoOrderOrThrow(orderId, scopeMatch);
    const ri = order.returnInfo || {};

    if (ri.rtoStatus === 'refund_rejected') {
      throw createHttpError(400, 'RTO_ALREADY_REJECTED', 'RTO refund already rejected');
    }
    if (ri.rtoStatus === 'resolved') {
      throw createHttpError(400, 'RTO_ALREADY_RESOLVED', 'RTO is already closed');
    }
    if (ri.rtoStatus === 'refunded') {
      throw createHttpError(400, 'RTO_ALREADY_REFUNDED', 'RTO refund already completed');
    }
    if (hasRtoRefundBeenInitiated(order)) {
      throw createHttpError(400, 'RTO_REFUND_ALREADY_INITIATED', 'RTO refund already initiated for this order');
    }

    const calc = calculateRtoRefund(order, { rtoShippingOverride });
    if (!calc.eligible || calc.maxRefundableInr <= 0) {
      throw createHttpError(
        400,
        'RTO_REFUND_NOT_ELIGIBLE',
        calc.reason === 'cod_no_refund'
          ? 'COD orders are not eligible for refund. Mark as resolved instead.'
          : calc.reason === 'partial_or_unpaid_no_refund' || calc.reason === 'partial_payment_no_refund'
            ? 'Partial payment orders are not eligible for refund. Mark as resolved instead.'
            : 'This order is not eligible for RTO refund.'
      );
    }

    const providerStatus = order.shipmentInfo?.providerStatus;
    if (!isRtoDeliveredToWarehouse(providerStatus)) {
      throw createHttpError(
        403,
        'RTO_WAREHOUSE_PENDING',
        'Refund is available only after Shiprocket reports RTO Delivered to warehouse.'
      );
    }

    if (!order.paymentInfo?.razorpayPaymentId) {
      throw createHttpError(400, 'RAZORPAY_PAYMENT_MISSING', 'No Razorpay payment on this order');
    }

    const refundInr = calc.maxRefundableInr;
    const paise = Math.round(refundInr * 100);
    const refund = await razorpay.payments.refund(order.paymentInfo.razorpayPaymentId, {
      amount: paise,
      speed: 'normal',
      notes: {
        orderId: order.orderId,
        reason: 'rto_refund'
      }
    });

    order.returnInfo = mergeReturnInfo(order.returnInfo, {
      rtoStatus: 'pending',
      rtoDeductions: calc.deductions,
      rtoRefundAmount: refundInr,
      rtoRefundId: refund.id,
      refundInitiatedAt: new Date(),
      rtoRefundError: null
    });

    await applyRtoRefundEntryToOrder(order, refund, req.user?.id || req.user?._id, calc);

    return res.json({
      success: true,
      message: 'RTO refund initiated successfully',
      data: {
        orderId: order.orderId,
        refund: {
          id: order.returnInfo?.rtoRefundId,
          amountInr: order.returnInfo?.rtoRefundAmount,
          status: deriveRefundTrackStatus(order)
        },
        calculation: calculateRtoRefund(order)
      }
    });
  } catch (err) {
    return sendError(res, err, 'Could not process RTO refund');
  }
};

/**
 * POST /api/admin/rto/reject — admin declines refund (customer fault / policy).
 */
exports.rejectRtoRefund = async (req, res) => {
  try {
    const { orderId, note } = req.body || {};
    if (!orderId) {
      throw createHttpError(400, 'ORDER_ID_REQUIRED', 'orderId is required');
    }

    const scopeMatch = req.adminScope?.orderMatch || {};
    const order = await findRtoOrderOrThrow(orderId, scopeMatch);
    const ri = order.returnInfo || {};

    if (ri.rtoStatus === 'refund_rejected') {
      throw createHttpError(400, 'RTO_ALREADY_REJECTED', 'RTO refund already rejected');
    }
    if (ri.rtoStatus === 'refunded') {
      throw createHttpError(400, 'RTO_ALREADY_REFUNDED', 'Order already refunded — cannot reject');
    }
    if (hasRtoRefundBeenInitiated(order)) {
      throw createHttpError(400, 'RTO_REFUND_IN_PROGRESS', 'Refund already initiated — cannot reject');
    }

    const providerStatus = order.shipmentInfo?.providerStatus || null;
    const reasonCategory = classifyRtoReasonCategory(providerStatus);
    const adminId = req.user?.id || req.user?._id || null;

    const paymentType = classifyRtoPaymentType(order);
    const isNoRefundCase = !paymentType.refundAllowed;

    order.returnInfo = mergeReturnInfo(order.returnInfo, {
      rtoStatus: 'refund_rejected',
      rtoRejectedAt: new Date(),
      rtoRejectedBy: adminId,
      rtoRejectionNote:
        note ||
        (isNoRefundCase
          ? 'RTO case closed — partial/COD, no Razorpay refund'
          : 'Refund denied by admin — no refund due'),
      rtoShiprocketReason: providerStatus,
      rtoReasonCategory: reasonCategory
    });

    appendRtoHistory(order, {
      action: isNoRefundCase ? 'rto_case_closed' : 'refund_rejected',
      note: note || (isNoRefundCase ? 'Case closed (no refund eligible)' : 'Admin denied refund'),
      performedBy: adminId,
      metadata: { shiprocketReason: providerStatus, reasonCategory, noRazorpay: true }
    });

    order.markModified('returnInfo');
    await order.save();

    return res.json({
      success: true,
      message: isNoRefundCase
        ? 'RTO case closed — no Razorpay refund (not eligible)'
        : 'Refund denied — no money will be returned via Razorpay',
      data: { order: mapRtoOrderRow(order) }
    });
  } catch (err) {
    return sendError(res, err, 'Could not reject RTO refund');
  }
};

/** @deprecated Use rejectRtoRefund */
exports.markRtoResolved = exports.rejectRtoRefund;

/**
 * POST /api/admin/rto/bulk-action
 */
exports.bulkRtoAction = async (req, res) => {
  try {
    const { orderIds, action, note } = req.body || {};
    const act = String(action || '').toLowerCase();
    if (!Array.isArray(orderIds) || !orderIds.length) {
      throw createHttpError(400, 'ORDER_IDS_REQUIRED', 'orderIds array is required');
    }
    if (!['refund', 'reject', 'resolve'].includes(act)) {
      throw createHttpError(400, 'INVALID_BULK_ACTION', 'action must be refund or reject');
    }

    const bulkReject = act === 'reject' || act === 'resolve';

    const scopeMatch = req.adminScope?.orderMatch || {};
    const results = [];
    const adminId = req.user?.id || req.user?._id || null;

    for (const rawId of orderIds.slice(0, 50)) {
      const orderId = String(rawId || '').trim();
      if (!orderId) continue;
      try {
        if (bulkReject) {
          const order = await findRtoOrderOrThrow(orderId, scopeMatch);
          const ri = order.returnInfo || {};
          if (ri.rtoStatus === 'refund_rejected') {
            results.push({ orderId, success: false, code: 'RTO_ALREADY_REJECTED', message: 'Already rejected' });
            continue;
          }
          if (ri.rtoStatus === 'refunded' || hasRtoRefundBeenInitiated(order)) {
            results.push({ orderId, success: false, code: 'RTO_NOT_REJECTABLE', message: 'Already refunded or refund in progress' });
            continue;
          }
          const providerStatus = order.shipmentInfo?.providerStatus || null;
          const reasonCategory = classifyRtoReasonCategory(providerStatus);
          order.returnInfo = mergeReturnInfo(order.returnInfo, {
            rtoStatus: 'refund_rejected',
            rtoRejectedAt: new Date(),
            rtoRejectedBy: adminId,
            rtoRejectionNote: note || 'Bulk reject — no refund',
            rtoShiprocketReason: providerStatus,
            rtoReasonCategory: reasonCategory
          });
          appendRtoHistory(order, {
            action: 'bulk_refund_rejected',
            note: note || 'Bulk reject',
            performedBy: adminId,
            metadata: { shiprocketReason: providerStatus, reasonCategory }
          });
          order.markModified('returnInfo');
          await order.save();
          results.push({ orderId, success: true });
        } else {
          const order = await findRtoOrderOrThrow(orderId, scopeMatch);
          const ri = order.returnInfo || {};
          if (ri.rtoStatus === 'refunded' || ri.rtoStatus === 'resolved') {
            results.push({ orderId, success: false, code: 'RTO_NOT_REFUNDABLE', message: 'Already refunded or resolved' });
            continue;
          }
          const calc = calculateRtoRefund(order);
          if (!calc.eligible || calc.maxRefundableInr <= 0) {
            results.push({
              orderId,
              success: false,
              code: 'RTO_REFUND_NOT_ELIGIBLE',
              message: 'Not eligible for refund'
            });
            continue;
          }
          if (!isRtoDeliveredToWarehouse(order.shipmentInfo?.providerStatus)) {
            results.push({
              orderId,
              success: false,
              code: 'RTO_WAREHOUSE_PENDING',
              message: 'RTO not yet delivered to warehouse'
            });
            continue;
          }
          if (!order.paymentInfo?.razorpayPaymentId) {
            results.push({ orderId, success: false, code: 'RAZORPAY_PAYMENT_MISSING', message: 'No Razorpay payment' });
            continue;
          }
          if (hasRtoRefundBeenInitiated(order)) {
            results.push({
              orderId,
              success: false,
              code: 'RTO_REFUND_ALREADY_INITIATED',
              message: 'Refund already initiated'
            });
            continue;
          }
          const paise = Math.round(calc.maxRefundableInr * 100);
          const refund = await razorpay.payments.refund(order.paymentInfo.razorpayPaymentId, {
            amount: paise,
            speed: 'normal',
            notes: { orderId: order.orderId, reason: 'rto_refund_bulk' }
          });
          order.returnInfo = mergeReturnInfo(order.returnInfo, {
            rtoDeductions: calc.deductions,
            rtoRefundAmount: calc.maxRefundableInr,
            rtoRefundId: refund.id,
            refundInitiatedAt: new Date(),
            rtoRefundError: null
          });
          await applyRtoRefundEntryToOrder(order, refund, adminId, calc);
          results.push({ orderId, success: true, refundId: refund.id, amountInr: calc.maxRefundableInr });
        }
      } catch (rowErr) {
        results.push({
          orderId,
          success: false,
          code: rowErr.code || 'BULK_ROW_FAILED',
          message: rowErr.message || 'Failed'
        });
      }
    }

    const ok = results.filter((r) => r.success).length;
    return res.json({
      success: true,
      message: `Bulk ${act}: ${ok}/${results.length} succeeded`,
      data: { results }
    });
  } catch (err) {
    return sendError(res, err, 'Bulk RTO action failed');
  }
};

/**
 * GET /api/admin/rto/analytics
 */
exports.getRtoAnalytics = async (req, res) => {
  try {
    const range = resolveDateRange({
      from: req.query.from,
      to: req.query.to,
      presetDays: req.query.presetDays,
      rangePreset: req.query.rangePreset || req.query.range || 'last30'
    });

    const scopeMatch = req.adminScope?.orderMatch || {};
    const baseFilter = mergeRtoFilters(
      Object.keys(scopeMatch).length
        ? { $and: [{ createdAt: { $gte: range.from, $lte: range.to } }, scopeMatch] }
        : { createdAt: { $gte: range.from, $lte: range.to } },
      buildRtoBucketMatch()
    );

    const orders = await Order.find(baseFilter)
      .select(
        'orderId subtotal totalAmount deliveryCharges paymentStatus paymentInfo returnInfo shipmentInfo createdAt'
      )
      .lean();

    let pending = 0;
    let refunded = 0;
    let resolved = 0;
    let refundFailed = 0;
    let customerRelated = 0;
    let courierRelated = 0;
    let totalRefundAmount = 0;
    let eligibleForRefund = 0;
    const byDay = {};

    for (const o of orders) {
      syncRtoRefundStatusFromOrder(o);
      const st = o.returnInfo?.rtoStatus || 'pending';
      if (st === 'refunded') refunded += 1;
      else if (st === 'resolved') resolved += 1;
      else if (st === 'refund_failed') refundFailed += 1;
      else pending += 1;

      const cat = classifyRtoReasonCategory(o.shipmentInfo?.providerStatus);
      if (cat === 'customer') customerRelated += 1;
      else if (cat === 'courier') courierRelated += 1;

      const calc = calculateRtoRefund(o);
      if (calc.eligible) eligibleForRefund += 1;
      if (o.returnInfo?.rtoRefundAmount) {
        totalRefundAmount += Number(o.returnInfo.rtoRefundAmount) || 0;
      }

      const dayKey = new Date(o.createdAt).toISOString().slice(0, 10);
      byDay[dayKey] = (byDay[dayKey] || 0) + 1;
    }

    const trend = Object.entries(byDay)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({ date, count }));

    return res.json({
      success: true,
      data: {
        dateRange: {
          from: range.from.toISOString(),
          to: range.to.toISOString(),
          preset: range.presetLabel
        },
        kpis: {
          totalRto: orders.length,
          pending,
          refunded,
          resolved,
          refundFailed,
          customerRelated,
          courierRelated,
          eligibleForRefund,
          totalRefundAmountInr: roundMoney2(totalRefundAmount)
        },
        trend
      }
    });
  } catch (err) {
    return sendError(res, err, 'Could not load RTO analytics');
  }
};

/**
 * GET /api/admin/rto/report
 */
exports.exportRtoReport = async (req, res) => {
  try {
    const range = resolveDateRange({
      from: req.query.from,
      to: req.query.to,
      presetDays: req.query.presetDays,
      rangePreset: req.query.rangePreset || req.query.range || 'last30'
    });

    const scopeMatch = req.adminScope?.orderMatch || {};
    const filter = mergeRtoFilters(
      Object.keys(scopeMatch).length
        ? { $and: [{ createdAt: { $gte: range.from, $lte: range.to } }, scopeMatch] }
        : { createdAt: { $gte: range.from, $lte: range.to } },
      buildRtoBucketMatch(),
      buildRtoSectionMatch(req.query.section),
      buildRtoStatusFilterMatch(req.query.status)
    );

    const orders = await Order.find(filter).sort({ createdAt: -1 }).limit(5000).lean();
    const format = String(req.query.format || 'csv').toLowerCase();

    const headers = [
      'Order ID',
      'Customer',
      'Phone',
      'Cart Value',
      'Order Total',
      'RTO Status',
      'Shiprocket Status',
      'Reason',
      'Refund Amount',
      'Net Refund (calc)',
      'Created At'
    ];

    const rows = orders.map((o) => {
      const mapped = mapRtoOrderRow(o);
      return [
        mapped.orderId,
        mapped.customerName,
        mapped.contactPhone || '',
        mapped.subtotalInr,
        mapped.amountInr,
        mapped.rtoStatus,
        mapped.providerStatus || '',
        mapped.rtoReason,
        mapped.rtoRefundAmount ?? '',
        mapped.refundCalculation?.netRefund ?? '',
        mapped.createdAt ? new Date(mapped.createdAt).toISOString() : ''
      ];
    });

    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json');
      return res.json({ success: true, data: { headers, rows } });
    }

    const escapeCsv = (v) => {
      const s = String(v ?? '');
      if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };

    const csv = [headers.map(escapeCsv).join(','), ...rows.map((r) => r.map(escapeCsv).join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="rto-report-${range.presetLabel}-${Date.now()}.csv"`
    );
    return res.send(csv);
  } catch (err) {
    return sendError(res, err, 'Could not export RTO report');
  }
};

module.exports.mapRtoOrderRow = mapRtoOrderRow;
