'use strict';

const logger = require('../../utils/logger');
const { getAdminOrderMatch } = require('../../utils/adminOrderScope');
const {
  getSettings,
  serializeSettings,
  updateSettings,
} = require('../services/sameDayDeliverySettings.service');
const {
  listSameDayOrders,
  aggregateSameDaySummary,
  findSddOrder,
  serializeSddOrder,
  shipSameDayOrder,
  cancelSameDayOrder,
  editSameDayItems,
} = require('../services/sameDayOrderAdmin.service');
const { resolveDateRange } = require('../../services/adminOrderDashboard.service');
const { shouldHideOrdersRevenueRequest } = require('../../utils/adminOrderRoles');

function sendError(res, err, fallback) {
  const status = err.statusCode && Number.isFinite(err.statusCode) ? err.statusCode : 500;
  const code = err.code || (status === 400 ? 'BAD_REQUEST' : 'INTERNAL_ERROR');
  const message =
    status === 500 && process.env.NODE_ENV === 'production' ? fallback : err.message || fallback;
  if (status >= 500) {
    logger.error('[sdd-admin]', { message: err.message, code, stack: err.stack });
  }
  return res.status(status).json({
    success: false,
    code,
    message,
    ...(err.field ? { field: err.field } : {}),
  });
}

function assertEcommAdmin(req) {
  const sf = req.adminScope?.storefront || req.storefront || 'ecomm';
  if (sf !== 'ecomm') {
    const err = new Error('Same day delivery admin is only available for ecomm.');
    err.statusCode = 400;
    err.code = 'SAME_DAY_ECOMM_ONLY';
    throw err;
  }
}

exports.getSettings = async (req, res) => {
  try {
    assertEcommAdmin(req);
    const doc = await getSettings();
    return res.json({ success: true, data: serializeSettings(doc) });
  } catch (err) {
    return sendError(res, err, 'Could not load same-day delivery settings');
  }
};

exports.updateSettings = async (req, res) => {
  try {
    assertEcommAdmin(req);
    const doc = await updateSettings({
      enabled: req.body?.enabled,
      pincodes: req.body?.pincodes,
      updatedBy: req.user?._id || req.userId || null,
    });
    return res.json({
      success: true,
      message: 'Same day delivery settings updated',
      data: serializeSettings(doc),
    });
  } catch (err) {
    return sendError(res, err, 'Could not update same-day delivery settings');
  }
};

function parseSddDateRange(query) {
  const q = query || {};
  const hasFrom = q.from != null && String(q.from).trim() !== '';
  const hasTo = q.to != null && String(q.to).trim() !== '';
  const hasPreset = String(q.rangePreset || '').trim() !== '';
  if (!hasFrom && !hasTo && !hasPreset && (q.presetDays == null || q.presetDays === '')) {
    return { from: null, to: null, presetLabel: 'all' };
  }
  return resolveDateRange({
    from: q.from,
    to: q.to,
    rangePreset: q.rangePreset || 'all',
    presetDays: q.presetDays,
  });
}

exports.getOrdersSummary = async (req, res) => {
  try {
    assertEcommAdmin(req);
    const range = parseSddDateRange(req.query);
    const summary = await aggregateSameDaySummary({
      from: range.from,
      to: range.to,
      scopeMatch: getAdminOrderMatch(req),
    });
    const hideRevenue = shouldHideOrdersRevenueRequest(req);
    return res.json({
      success: true,
      data: {
        dateRange: {
          from: range.from ? range.from.toISOString() : null,
          to: range.to ? range.to.toISOString() : null,
          preset: range.presetLabel,
        },
        totals: {
          totalOrders: summary.totalOrders,
          totalRevenueInr: hideRevenue ? null : summary.totalRevenueInr,
          totalPendingOrders: summary.totalPendingOrders,
          totalCompletedOrders: summary.totalCompletedOrders,
        },
        countsByTab: summary.countsByTab,
      },
    });
  } catch (err) {
    return sendError(res, err, 'Could not load same-day order summary');
  }
};

exports.listOrders = async (req, res) => {
  try {
    assertEcommAdmin(req);
    const range = parseSddDateRange(req.query);
    const result = await listSameDayOrders({
      tab: req.query.tab,
      page: req.query.page,
      limit: req.query.limit,
      search: req.query.search,
      from: range.from,
      to: range.to,
      scopeMatch: getAdminOrderMatch(req),
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    return sendError(res, err, 'Could not load same-day orders');
  }
};

exports.getOrder = async (req, res) => {
  try {
    assertEcommAdmin(req);
    const order = await findSddOrder(req.params.orderId, getAdminOrderMatch(req));
    await order.populate([
      { path: 'items.productId', select: 'name slug images variants' },
      { path: 'userId', select: 'name email phone' },
    ]);
    return res.json({ success: true, data: serializeSddOrder(order) });
  } catch (err) {
    return sendError(res, err, 'Could not load same-day order');
  }
};

exports.shipOrder = async (req, res) => {
  try {
    assertEcommAdmin(req);
    const result = await shipSameDayOrder({
      orderId: req.params.orderId,
      adminUserId: req.user?._id || req.userId || null,
      scopeMatch: getAdminOrderMatch(req),
    });
    return res.json({
      success: true,
      message: result.alreadyShipped ? 'Order already shipped' : 'Order marked shipped',
      data: serializeSddOrder(result.order),
    });
  } catch (err) {
    return sendError(res, err, 'Could not ship same-day order');
  }
};

exports.cancelOrder = async (req, res) => {
  try {
    assertEcommAdmin(req);
    const result = await cancelSameDayOrder({
      orderId: req.params.orderId,
      adminUserId: req.user?._id || req.userId || null,
      reason: req.body?.reason,
      scopeMatch: getAdminOrderMatch(req),
    });
    return res.json({
      success: true,
      message: result.alreadyCancelled
        ? 'Order already cancelled'
        : result.refundWarning || 'Order cancelled',
      data: serializeSddOrder(result.order),
      refundWarning: result.refundWarning || null,
    });
  } catch (err) {
    return sendError(res, err, 'Could not cancel same-day order');
  }
};

exports.previewEdit = async (req, res) => {
  try {
    assertEcommAdmin(req);
    const result = await editSameDayItems({
      orderId: req.params.orderId,
      itemUpdates: req.body?.itemUpdates,
      commit: false,
      adminUserId: req.user?._id || req.userId || null,
      scopeMatch: getAdminOrderMatch(req),
    });
    return res.json({ success: true, data: result.preview });
  } catch (err) {
    return sendError(res, err, 'Could not preview same-day order edit');
  }
};

exports.applyEdit = async (req, res) => {
  try {
    assertEcommAdmin(req);
    const result = await editSameDayItems({
      orderId: req.params.orderId,
      itemUpdates: req.body?.itemUpdates,
      commit: true,
      adminUserId: req.user?._id || req.userId || null,
      scopeMatch: getAdminOrderMatch(req),
    });
    return res.json({
      success: true,
      message: result.cancelledEmpty
        ? 'Order cancelled — no items remaining.'
        : result.refundInr > 0
          ? 'Order updated and refund initiated where applicable.'
          : 'Order updated successfully.',
      data: {
        preview: result.preview,
        order: result.order ? serializeSddOrder(result.order) : null,
        refundInr: result.refundInr,
      },
    });
  } catch (err) {
    return sendError(res, err, 'Could not edit same-day order');
  }
};
