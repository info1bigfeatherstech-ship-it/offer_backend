'use strict';

const Razorpay = require('razorpay');
const Order = require('../../models/Order');
const logger = require('../../utils/logger');
const { roundMoney2, calculateTax } = require('../../services/checkoutComputation.service');
const { releaseReservedInventoryForLines } = require('../../services/orderInventory.service');
const { releaseOrderStockHold, syncHoldAfterPendingOrderEdit } = require('../../services/orderStockBridge.service');
const { mergeReturnInfo } = require('../../services/rtoRefund.service');
const { mergeOrderScopeFilter } = require('../../utils/adminOrderScope');
const {
  buildSameDayPendingMatch,
  buildSameDayShippedMatch,
  buildSameDayCancelledMatch,
  isSameDayOrder,
} = require('../constants/sameDayDeliveryOrderQuery');
const { createSddHttpError } = require('../utils/sameDayDeliveryMode');
const { assertSameDayShipPayment } = require('../utils/sameDayShipPaymentGate');

const razorpay =
  String(process.env.RAZORPAY_KEY_ID || '').trim() && String(process.env.RAZORPAY_KEY_SECRET || '').trim()
    ? new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET,
      })
    : null;

function lineKey(productId, variantId) {
  return `${String(productId || '')}:${String(variantId || '')}`;
}

function unitSalePrice(item) {
  const sale = item?.priceSnapshot?.sale;
  if (sale != null && Number.isFinite(Number(sale))) return roundMoney2(Number(sale));
  const total = Number(item?.priceSnapshot?.total) || 0;
  const qty = Number(item?.quantity) || 1;
  return roundMoney2(total / Math.max(1, qty));
}

async function findSddOrder(orderId, scopeMatch) {
  const id = String(orderId || '').trim();
  if (!id) throw createSddHttpError(400, 'ORDER_ID_REQUIRED', 'orderId is required');
  const order = await Order.findOne(mergeOrderScopeFilter({ orderId: id }, scopeMatch));
  if (!order || !isSameDayOrder(order)) {
    throw createSddHttpError(404, 'NOT_FOUND', 'Same day order not found');
  }
  return order;
}

function serializeSddOrder(order) {
  const o = order.toObject ? order.toObject() : order;
  const user = o.userId && typeof o.userId === 'object' ? o.userId : null;
  return {
    id: o._id,
    orderId: o.orderId,
    enquiryType: 'same_day',
    fulfillmentMode: 'same_day',
    orderStatus: o.orderStatus,
    paymentStatus: o.paymentStatus,
    name: o.addressSnapshot?.fullName || o.addressSnapshot?.name || user?.name || null,
    phone: o.addressSnapshot?.phone || user?.phone || null,
    pincode: o.sameDay?.pincode || o.addressSnapshot?.postalCode || null,
    city: o.addressSnapshot?.city || null,
    items: o.items,
    subtotal: o.subtotal,
    tax: o.tax,
    discount: o.discount,
    deliveryCharges: 0,
    totalAmount: o.totalAmount,
    amountPaidInr: o.amountPaidInr,
    balanceDueInr: o.balanceDueInr,
    adminNote: o.adminNote || null,
    shippedAt: o.sameDay?.shippedAt || null,
    cancelledAt: o.sameDay?.cancelledAt || null,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    addressSnapshot: o.addressSnapshot || null,
    refundHistory: o.refundHistory || [],
    paymentInfo: o.paymentInfo || null,
    appliedCoupon: o.appliedCoupon || null,
    shippingWeightSnapshot: o.shippingWeightSnapshot || null,
    removedItemsArchive: o.removedItemsArchive || [],
    customer: {
      name: user?.name || o.addressSnapshot?.fullName || o.addressSnapshot?.name || null,
      email: user?.email || null,
      phone: user?.phone || o.addressSnapshot?.phone || null,
    },
  };
}

function appendDateRange(filterAnd, from, to) {
  if (
    from instanceof Date &&
    to instanceof Date &&
    !Number.isNaN(from.getTime()) &&
    !Number.isNaN(to.getTime())
  ) {
    filterAnd.push({ createdAt: { $gte: from, $lte: to } });
  }
}

function mergeScope(filterAnd, scopeMatch) {
  if (scopeMatch && Object.keys(scopeMatch).length) filterAnd.push(scopeMatch);
}

async function aggregateSameDaySummary({ from = null, to = null, scopeMatch } = {}) {
  const matchAnd = [{ fulfillmentMode: 'same_day' }];
  appendDateRange(matchAnd, from, to);
  mergeScope(matchAnd, scopeMatch);

  const [row] = await Order.aggregate([
    { $match: { $and: matchAnd } },
    {
      $group: {
        _id: null,
        totalOrders: {
          $sum: {
            $cond: [{ $not: { $in: ['$orderStatus', ['cancelled', 'payment_failed']] } }, 1, 0],
          },
        },
        totalPendingOrders: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ['$orderStatus', 'confirmed'] },
                  { $in: ['$paymentStatus', ['paid', 'partially_refunded']] },
                ],
              },
              1,
              0,
            ],
          },
        },
        totalCompletedOrders: {
          $sum: { $cond: [{ $eq: ['$orderStatus', 'shipped'] }, 1, 0] },
        },
        totalRevenueInr: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $not: { $in: ['$orderStatus', ['cancelled', 'payment_failed']] } },
                  { $ne: ['$paymentStatus', 'failed'] },
                ],
              },
              '$totalAmount',
              0,
            ],
          },
        },
        cancelledCount: {
          $sum: { $cond: [{ $eq: ['$orderStatus', 'cancelled'] }, 1, 0] },
        },
      },
    },
  ]).exec();

  const t = row || {};
  return {
    totalOrders: t.totalOrders || 0,
    totalPendingOrders: t.totalPendingOrders || 0,
    totalCompletedOrders: t.totalCompletedOrders || 0,
    totalRevenueInr: roundMoney2(t.totalRevenueInr || 0),
    countsByTab: {
      pending: t.totalPendingOrders || 0,
      shipped: t.totalCompletedOrders || 0,
      cancelled: t.cancelledCount || 0,
    },
  };
}

async function listSameDayOrders({
  tab = 'pending',
  page = 1,
  limit = 20,
  search = '',
  from = null,
  to = null,
  scopeMatch,
}) {
  const safePage = Math.max(1, parseInt(String(page), 10) || 1);
  const safeLimit = Math.min(100, Math.max(1, parseInt(String(limit), 10) || 20));
  const tabKey = String(tab || 'pending').toLowerCase();
  let tabMatch;
  if (tabKey === 'shipped') tabMatch = buildSameDayShippedMatch();
  else if (tabKey === 'cancelled') tabMatch = buildSameDayCancelledMatch();
  else tabMatch = buildSameDayPendingMatch();

  const filter = { $and: [tabMatch] };
  mergeScope(filter.$and, scopeMatch);

  const q = String(search || '').trim();
  if (q) {
    const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(safe, 'i');
    filter.$and.push({
      $or: [
        { orderId: re },
        { 'addressSnapshot.fullName': re },
        { 'addressSnapshot.name': re },
        { 'addressSnapshot.phone': re },
        { 'addressSnapshot.postalCode': re },
        { 'sameDay.pincode': re },
      ],
    });
  } else {
    appendDateRange(filter.$and, from, to);
  }

  const [rows, total] = await Promise.all([
    Order.find(filter)
      .sort({ createdAt: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .lean(),
    Order.countDocuments(filter),
  ]);

  return {
    data: rows.map(serializeSddOrder),
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      totalPages: Math.ceil(total / safeLimit) || 0,
      hasNextPage: safePage * safeLimit < total,
      hasPrevPage: safePage > 1,
    },
  };
}

async function attemptRefund(order, refundInr, reason) {
  if (!(refundInr > 0.005)) return { refundAttempted: false, refund: null, warning: null };
  const paymentId = order.paymentInfo?.razorpayPaymentId;
  if (!paymentId || !razorpay) {
    return {
      refundAttempted: false,
      refund: null,
      warning: 'Refund amount is due but Razorpay is not configured or payment id is missing.',
    };
  }
  const paise = Math.round(refundInr * 100);
  if (paise < 1) return { refundAttempted: false, refund: null, warning: null };
  try {
    const refund = await razorpay.payments.refund(paymentId, {
      amount: paise,
      speed: 'normal',
      notes: { orderId: order.orderId, reason: reason || 'same_day_order' },
    });
    const amountInr = roundMoney2(Number(refund.amount) / 100);
    order.refundHistory = order.refundHistory || [];
    if (!order.refundHistory.some((r) => r.refundId === refund.id)) {
      order.refundHistory.push({
        refundId: refund.id,
        amountInr,
        amountPaise: Number(refund.amount),
        status: refund.status || 'processed',
        reason: reason || 'same_day_order',
        createdAt: new Date(),
      });
    }
    order.markModified('refundHistory');
    return { refundAttempted: true, refund, warning: null };
  } catch (err) {
    logger.error('[sdd] refund failed', { orderId: order.orderId, message: err.message });
    return {
      refundAttempted: true,
      refund: null,
      warning: err?.error?.description || err.message || 'Refund API failed',
    };
  }
}

async function shipSameDayOrder({ orderId, adminUserId, scopeMatch }) {
  const order = await findSddOrder(orderId, scopeMatch);
  const status = String(order.orderStatus || '').toLowerCase();
  if (status === 'shipped') {
    return { order, alreadyShipped: true };
  }
  if (status !== 'confirmed') {
    throw createSddHttpError(
      400,
      'ORDER_NOT_SHIPPABLE',
      `Only confirmed same-day orders can be shipped (current: ${order.orderStatus}).`
    );
  }
  assertSameDayShipPayment(order);
  order.orderStatus = 'shipped';
  order.sameDay = order.sameDay || {};
  order.sameDay.shippedAt = new Date();
  order.sameDay.shippedBy = adminUserId || null;
  order.markModified('sameDay');
  await order.save();
  return { order, alreadyShipped: false };
}

async function cancelSameDayOrder({ orderId, adminUserId, reason, scopeMatch }) {
  const order = await findSddOrder(orderId, scopeMatch);
  const status = String(order.orderStatus || '').toLowerCase();
  if (status === 'cancelled') {
    const pendingRefund = ['refund_pending', 'refund_failed'].includes(
      String(order.returnInfo?.status || '')
    );
    const due = roundMoney2(Number(order.returnInfo?.refundAmount) || Number(order.amountPaidInr) || 0);
    if (pendingRefund && due > 0.005) {
      const retry = await attemptRefund(order, due, 'same_day_order_cancelled');
      if (retry.refund) {
        order.paymentStatus = 'refunded';
        order.returnInfo = mergeReturnInfo(order.returnInfo, {
          refundContext: 'cancellation',
          refundAmount: due,
          refundId: retry.refund.id,
          status: 'refunded',
          approvedAt: new Date(),
        });
        order.markModified('returnInfo');
        await order.save();
      }
      return { order, alreadyCancelled: true, refundWarning: retry.warning };
    }
    return { order, alreadyCancelled: true, refundWarning: null };
  }
  if (status === 'shipped') {
    throw createSddHttpError(400, 'ORDER_ALREADY_SHIPPED', 'Shipped same-day orders cannot be cancelled.');
  }
  if (status !== 'confirmed') {
    throw createSddHttpError(
      400,
      'ORDER_NOT_CANCELLABLE',
      `Only confirmed same-day orders can be cancelled (current: ${order.orderStatus}).`
    );
  }

  const refundInr = roundMoney2(Number(order.amountPaidInr) || 0);
  order.orderStatus = 'cancelled';
  order.sameDay = order.sameDay || {};
  order.sameDay.cancelledAt = new Date();
  order.sameDay.cancelledBy = adminUserId || null;
  order.markModified('sameDay');
  order.paymentInfo = order.paymentInfo || {};
  order.paymentInfo.cancellationReason = reason || 'admin_cancelled_same_day';
  order.paymentInfo.cancelledAt = new Date();
  order.markModified('paymentInfo');
  order.returnInfo = mergeReturnInfo(order.returnInfo, {
    refundContext: 'cancellation',
    refundAmount: refundInr,
    status: refundInr > 0.005 ? 'refund_pending' : 'not_required',
    requestedAt: new Date(),
  });
  order.markModified('returnInfo');

  await releaseOrderStockHold(order);
  await order.save();

  const refund = await attemptRefund(order, refundInr, 'same_day_order_cancelled');
  if (refund.refund) {
    order.paymentStatus = 'refunded';
    order.returnInfo = mergeReturnInfo(order.returnInfo, {
      refundContext: 'cancellation',
      refundAmount: refundInr,
      refundId: refund.refund.id,
      status: 'refunded',
      approvedAt: new Date(),
    });
    order.markModified('returnInfo');
    await order.save();
  } else if (refundInr > 0.005) {
    order.returnInfo = mergeReturnInfo(order.returnInfo, {
      refundContext: 'cancellation',
      refundAmount: refundInr,
      status: refund.warning ? 'refund_failed' : 'refund_pending',
    });
    order.markModified('returnInfo');
    await order.save();
  }
  return { order, alreadyCancelled: false, refundWarning: refund.warning };
}

function taxFromItems(items) {
  return calculateTax(
    (items || []).map((item) => ({
      product: { gstRate: item.gstRate },
      itemTotal: Number(item.priceSnapshot?.total) || 0,
    }))
  );
}

async function editSameDayItems({ orderId, itemUpdates, commit, adminUserId, scopeMatch }) {
  if (!Array.isArray(itemUpdates)) {
    throw createSddHttpError(400, 'VALIDATION_FAILED', 'itemUpdates must be an array');
  }
  const order = await findSddOrder(orderId, scopeMatch);
  const status = String(order.orderStatus || '').toLowerCase();
  if (status !== 'confirmed') {
    throw createSddHttpError(
      400,
      'ORDER_NOT_EDITABLE',
      'Only confirmed (pending ship) same-day orders can be edited.'
    );
  }

  const updatesByKey = new Map();
  for (const u of itemUpdates) {
    const key = lineKey(u.productId, u.variantId);
    const qty = Number(u.quantity);
    if (!Number.isFinite(qty) || qty < 0 || !Number.isInteger(qty)) {
      throw createSddHttpError(400, 'INVALID_QUANTITY', 'Item quantity must be a whole number ≥ 0');
    }
    updatesByKey.set(key, qty);
  }

  const nextItems = [];
  const changeSummaries = [];
  for (const item of order.items || []) {
    const pid = item.productId?._id || item.productId;
    const vid = item.variantId?._id || item.variantId;
    const key = lineKey(pid, vid);
    const oldQty = Number(item.quantity) || 0;
    const nextQty = updatesByKey.has(key) ? updatesByKey.get(key) : oldQty;
    if (nextQty > oldQty) {
      throw createSddHttpError(400, 'QTY_INCREASE_NOT_ALLOWED', 'Cannot increase item quantity.');
    }
    if (nextQty === oldQty) {
      nextItems.push(item);
      continue;
    }
    const unit = unitSalePrice(item);
    const removedQty = oldQty - nextQty;
    changeSummaries.push({
      action: nextQty === 0 ? 'removed' : 'qty_reduced',
      productId: pid,
      variantId: vid,
      productName: item.productId?.name || 'Product',
      oldQuantity: oldQty,
      newQuantity: nextQty,
      amountRemovedInr: roundMoney2(unit * removedQty),
    });
    if (nextQty === 0) continue;
    const clone = item.toObject ? item.toObject() : { ...item };
    clone.quantity = nextQty;
    clone.priceSnapshot = {
      ...(clone.priceSnapshot || {}),
      total: roundMoney2(unit * nextQty),
    };
    nextItems.push(clone);
  }

  const subtotal = roundMoney2(
    nextItems.reduce((sum, it) => sum + (Number(it.priceSnapshot?.total) || 0), 0)
  );
  const tax = taxFromItems(nextItems);
  const prevDiscount = roundMoney2(Number(order.discount) || 0);
  const discount = Math.min(prevDiscount, subtotal);
  const totalAmount = roundMoney2(Math.max(0, subtotal + tax - discount));
  const paid = roundMoney2(Number(order.amountPaidInr) || 0);
  const refundInr = roundMoney2(Math.max(0, paid - totalAmount));

  const preview = {
    changeSummaries,
    before: {
      subtotal: order.subtotal,
      tax: order.tax,
      discount: order.discount,
      totalAmount: order.totalAmount,
    },
    after: { subtotal, tax, discount, deliveryCharges: 0, totalAmount, refundInr },
    cancelledEmpty: nextItems.length === 0,
  };

  if (!commit) return { preview, refundInr, cancelledEmpty: preview.cancelledEmpty };

  if (nextItems.length === 0) {
    return cancelSameDayOrder({
      orderId,
      adminUserId,
      reason: 'same_day_all_items_removed',
      scopeMatch,
    }).then((r) => ({ ...r, preview, refundInr, cancelledEmpty: true }));
  }

  const releasedLines = changeSummaries
    .filter((c) => c.action === 'removed' || c.action === 'qty_reduced')
    .map((c) => ({
      productId: c.productId,
      variantId: c.variantId,
      quantity: c.oldQuantity - c.newQuantity,
    }));
  if (releasedLines.length) {
    try {
      await releaseReservedInventoryForLines(order, releasedLines);
      await syncHoldAfterPendingOrderEdit(order, nextItems);
    } catch (err) {
      logger.error('[sdd] inventory sync after edit failed', {
        orderId: order.orderId,
        message: err.message,
      });
    }
  }

  order.items = nextItems;
  order.subtotal = subtotal;
  order.tax = tax;
  order.discount = discount;
  order.deliveryCharges = 0;
  order.totalAmount = totalAmount;
  order.balanceDueInr = 0;
  order.markModified('items');
  await order.save();

  if (refundInr > 0.005) {
    order.amountPaidInr = totalAmount;
    const refund = await attemptRefund(order, refundInr, 'same_day_item_unavailable');
    if (refund.refund) {
      order.paymentStatus = refundInr >= paid - 0.01 ? 'refunded' : 'partially_refunded';
    }
    preview.refundWarning = refund.warning;
    await order.save();
  }
  return { order, preview, refundInr, cancelledEmpty: false };
}

module.exports = {
  listSameDayOrders,
  aggregateSameDaySummary,
  findSddOrder,
  serializeSddOrder,
  shipSameDayOrder,
  cancelSameDayOrder,
  editSameDayItems,
};
