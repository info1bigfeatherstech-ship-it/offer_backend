/**
 * Admin pending-order line edit (before accept / Shiprocket create).
 * - Remove lines or reduce qty only (no adds / qty increases)
 * - Rebuild weight snapshot + cheapest courier re-quote
 * - Freeze coupon/discount
 * - Online/prepaid (captured): Apply updates items only — NO Razorpay refund yet.
 *   Shipping held; after Ship Now actual freight → final bill + refund (never raise due/COD).
 *   See oosShippingSettlement.service (policyVersion 3).
 * - COD: immediate shipping reprice + balanceDue update (unchanged)
 * - Empty cart → cancel + refund amount paid
 */
const Razorpay = require('razorpay');
const Order = require('../models/Order');
const Product = require('../models/Product');
const logger = require('../utils/logger');
const {
  roundMoney2,
  calculateTax,
  aggregateShipping
} = require('./checkoutComputation.service');
const { buildShippingWeightSnapshotFromCheckoutLines } = require('../utils/shippingWeightSnapshot');
const { resolveVariantShipping } = require('../utils/variantCatalogFields');
const ShiprocketService = require('../utils/shiprocket');
const { releaseReservedInventoryForLines } = require('./orderInventory.service');
const {
  releaseOrderStockHold,
  syncHoldAfterPendingOrderEdit,
  readHold
} = require('./orderStockBridge.service');
const { mergeReturnInfo } = require('./rtoRefund.service');
const { notifyOrderAmended } = require('./orderAmendmentNotification.service');
const {
  shouldDeferShippingSettlement,
  buildOosShippingSettlementMeta,
  computeDeferredApplyFinancials
} = require('./oosShippingSettlement.service');

const razorpay =
  String(process.env.RAZORPAY_KEY_ID || '').trim() && String(process.env.RAZORPAY_KEY_SECRET || '').trim()
    ? new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET
      })
    : null;

function createEditError(statusCode, code, message, details = null) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  if (details) err.details = details;
  return err;
}

function lineKey(productId, variantId) {
  return `${String(productId || '')}:${String(variantId || '')}`;
}

function formatInrDisplay(amount) {
  const n = roundMoney2(Number(amount) || 0);
  return n % 1 === 0 ? String(Math.round(n)) : n.toFixed(2);
}

function snapshotMoney(order) {
  return {
    subtotal: roundMoney2(Number(order.subtotal) || 0),
    deliveryCharges: roundMoney2(Number(order.deliveryCharges) || 0),
    tax: roundMoney2(Number(order.tax) || 0),
    discount: roundMoney2(Number(order.discount) || 0),
    totalAmount: roundMoney2(Number(order.totalAmount) || 0),
    amountPaidInr: roundMoney2(Number(order.amountPaidInr) || 0),
    balanceDueInr: roundMoney2(Number(order.balanceDueInr) || 0),
    paymentStatus: order.paymentStatus || null
  };
}

function unitSalePrice(item) {
  const sale = Number(item?.priceSnapshot?.sale);
  if (Number.isFinite(sale) && sale >= 0) return roundMoney2(sale);
  const base = Number(item?.priceSnapshot?.base);
  if (Number.isFinite(base) && base >= 0) return roundMoney2(base);
  const total = Number(item?.priceSnapshot?.total);
  const qty = Math.max(1, Number(item?.quantity) || 1);
  if (Number.isFinite(total)) return roundMoney2(total / qty);
  return 0;
}

function taxFromItems(items) {
  return calculateTax(
    (items || []).map((item) => ({
      product: { gstRate: item.gstRate },
      itemTotal: Number(item.priceSnapshot?.total) || 0
    }))
  );
}

function assertEditablePendingOrder(order) {
  if (!order) {
    throw createEditError(404, 'ORDER_NOT_FOUND', 'Order not found');
  }
  const status = String(order.orderStatus || '').toLowerCase();
  if (status !== 'pending') {
    throw createEditError(
      400,
      'ORDER_NOT_EDITABLE',
      `Only pending orders can be edited before accept (current: ${order.orderStatus || 'unknown'}).`
    );
  }
  const si = order.shipmentInfo || {};
  if (si.shiprocketOrderId || si.shipmentId || si.awbCode || si.trackingNumber) {
    throw createEditError(
      400,
      'ORDER_ALREADY_ON_SHIPROCKET',
      'Cannot edit items after a Shiprocket shipment has been created. Cancel shipment first if needed.'
    );
  }
  if (si.pickupScheduledAt || si.pickupDate) {
    throw createEditError(
      400,
      'ORDER_PICKUP_SCHEDULED',
      'Cannot edit items after pickup is scheduled.'
    );
  }
}

/**
 * Parse admin item changes — only existing lines; qty may stay same, decrease, or 0 (remove).
 * @param {object} order
 * @param {Array<{ productId: string, variantId: string, quantity: number }>} itemUpdates
 */
function applyItemUpdatesToOrderItems(order, itemUpdates) {
  if (!Array.isArray(itemUpdates) || itemUpdates.length === 0) {
    throw createEditError(400, 'ITEM_UPDATES_REQUIRED', 'itemUpdates is required');
  }

  const existing = Array.isArray(order.items) ? order.items : [];
  const byKey = new Map();
  for (const item of existing) {
    const pid = item.productId?._id || item.productId;
    const vid = item.variantId?._id || item.variantId;
    byKey.set(lineKey(pid, vid), item);
  }

  const seen = new Set();
  const nextItems = [];
  const releasedLines = [];
  const changeSummaries = [];

  for (const upd of itemUpdates) {
    const pid = String(upd.productId || '').trim();
    const vid = String(upd.variantId || '').trim();
    if (!pid || !vid) {
      throw createEditError(400, 'ITEM_UPDATE_INVALID', 'Each update needs productId and variantId');
    }
    const key = lineKey(pid, vid);
    if (seen.has(key)) {
      throw createEditError(400, 'ITEM_UPDATE_DUPLICATE', `Duplicate update for ${key}`);
    }
    seen.add(key);

    const current = byKey.get(key);
    if (!current) {
      throw createEditError(
        400,
        'ITEM_NOT_ON_ORDER',
        'Cannot add new products here — only remove or reduce quantity on existing lines.'
      );
    }

    const oldQty = Math.max(0, Number(current.quantity) || 0);
    const newQtyRaw = Number(upd.quantity);
    if (!Number.isFinite(newQtyRaw) || newQtyRaw < 0 || !Number.isInteger(newQtyRaw)) {
      throw createEditError(400, 'QUANTITY_INVALID', 'Quantity must be a non-negative integer');
    }
    const newQty = newQtyRaw;
    if (newQty > oldQty) {
      throw createEditError(
        400,
        'QUANTITY_INCREASE_NOT_ALLOWED',
        'Quantity increases are not allowed. Only reduce qty or remove items that are out of stock.'
      );
    }

    const unit = unitSalePrice(current);
    const removedQty = oldQty - newQty;
    if (removedQty > 0) {
      releasedLines.push({
        productId: current.productId?._id || current.productId,
        variantId: current.variantId?._id || current.variantId,
        quantity: removedQty
      });
    }

    const productName =
      current.productId?.name ||
      (order.shippingWeightSnapshot?.lines || []).find(
        (l) => lineKey(l.productId, l.variantId) === key
      )?.productName ||
      'Item';

    if (newQty === 0) {
      changeSummaries.push({
        productId: pid,
        variantId: vid,
        productName,
        action: 'removed',
        oldQuantity: oldQty,
        newQuantity: 0,
        amountRemovedInr: roundMoney2(unit * oldQty)
      });
      continue;
    }

    if (newQty === oldQty) {
      nextItems.push({
        productId: current.productId?._id || current.productId,
        variantId: current.variantId?._id || current.variantId,
        quantity: oldQty,
        priceSnapshot: {
          base: Number(current.priceSnapshot?.base) || unit,
          sale: current.priceSnapshot?.sale != null ? Number(current.priceSnapshot.sale) : unit,
          total: roundMoney2(Number(current.priceSnapshot?.total) || unit * oldQty)
        },
        variantAttributesSnapshot: current.variantAttributesSnapshot || [],
        userType: current.userType,
        hsnCode: current.hsnCode ?? null,
        gstRate: current.gstRate ?? null,
        isFragile: Boolean(current.isFragile)
      });
      continue;
    }

    const lineTotal = roundMoney2(unit * newQty);
    nextItems.push({
      productId: current.productId?._id || current.productId,
      variantId: current.variantId?._id || current.variantId,
      quantity: newQty,
      priceSnapshot: {
        base: Number(current.priceSnapshot?.base) || unit,
        sale: current.priceSnapshot?.sale != null ? Number(current.priceSnapshot.sale) : unit,
        total: lineTotal
      },
      variantAttributesSnapshot: current.variantAttributesSnapshot || [],
      userType: current.userType,
      hsnCode: current.hsnCode ?? null,
      gstRate: current.gstRate ?? null,
      isFragile: Boolean(current.isFragile)
    });
    changeSummaries.push({
      productId: pid,
      variantId: vid,
      productName,
      action: 'qty_reduced',
      oldQuantity: oldQty,
      newQuantity: newQty,
      amountRemovedInr: roundMoney2(unit * removedQty)
    });
  }

  // Keep untouched lines that were not listed in itemUpdates
  for (const item of existing) {
    const pid = item.productId?._id || item.productId;
    const vid = item.variantId?._id || item.variantId;
    const key = lineKey(pid, vid);
    if (seen.has(key)) continue;
    nextItems.push({
      productId: pid,
      variantId: vid,
      quantity: item.quantity,
      priceSnapshot: {
        base: Number(item.priceSnapshot?.base) || unitSalePrice(item),
        sale: item.priceSnapshot?.sale != null ? Number(item.priceSnapshot.sale) : unitSalePrice(item),
        total: roundMoney2(Number(item.priceSnapshot?.total) || unitSalePrice(item) * (Number(item.quantity) || 0))
      },
      variantAttributesSnapshot: item.variantAttributesSnapshot || [],
      userType: item.userType,
      hsnCode: item.hsnCode ?? null,
      gstRate: item.gstRate ?? null,
      isFragile: Boolean(item.isFragile)
    });
  }

  const meaningful = changeSummaries.filter((c) => c.action === 'removed' || c.action === 'qty_reduced');
  if (meaningful.length === 0 && nextItems.length === existing.length) {
    const qtyChanged = itemUpdates.some((u) => {
      const cur = byKey.get(lineKey(u.productId, u.variantId));
      return cur && Number(u.quantity) !== Number(cur.quantity);
    });
    if (!qtyChanged) {
      throw createEditError(400, 'NO_CHANGES', 'No item quantity changes provided');
    }
  }

  return { nextItems, releasedLines, changeSummaries: meaningful };
}

async function loadCheckoutLinesForItems(items) {
  const lines = [];
  for (const item of items) {
    const pid = item.productId?._id || item.productId;
    const vid = item.variantId?._id || item.variantId;
    const product = await Product.findById(pid).select('name slug variants shipping').lean();
    if (!product) {
      throw createEditError(400, 'PRODUCT_NOT_FOUND', `Product ${pid} not found for shipping recalculation`);
    }
    const variant = (product.variants || []).find((v) => String(v._id) === String(vid));
    if (!variant) {
      throw createEditError(400, 'VARIANT_NOT_FOUND', `Variant ${vid} not found on product`);
    }
    const resolvedShipping = resolveVariantShipping(variant, product);
    lines.push({
      product,
      variant,
      quantity: item.quantity,
      resolvedShipping,
      itemTotal: Number(item.priceSnapshot?.total) || 0
    });
  }
  return lines;
}

function estimateCodAmount(order, provisionalTotal, amountPaidInr) {
  const method = String(order.paymentInfo?.method || '').toLowerCase();
  if (method === 'cod') {
    return Math.max(0, roundMoney2(provisionalTotal));
  }
  const balanceCod = String(order.paymentInfo?.balanceCollectionMethod || 'online').toLowerCase() === 'cod';
  const splitAdv = String(order.paymentInfo?.splitMode || 'full').toLowerCase() === 'advance';
  if ((method === 'online' || method === 'prepaid') && balanceCod && splitAdv) {
    return Math.max(0, roundMoney2(provisionalTotal - amountPaidInr));
  }
  return 0;
}

/**
 * Re-quote cheapest courier; customer delivery never increases.
 */
async function repriceShippingForItems(order, nextItems) {
  const postalCode = String(order.addressSnapshot?.postalCode || '')
    .replace(/\D/g, '')
    .slice(0, 6);
  if (!postalCode || postalCode.length !== 6) {
    throw createEditError(400, 'POSTAL_CODE_INVALID', 'Order address is missing a valid pincode');
  }

  const discount = roundMoney2(Number(order.discount) || 0);
  const oldDelivery = roundMoney2(Number(order.deliveryCharges) || 0);
  const amountPaidInr = roundMoney2(Number(order.amountPaidInr) || 0);
  const subtotal = roundMoney2(
    nextItems.reduce((s, it) => s + (Number(it.priceSnapshot?.total) || 0), 0)
  );
  const tax = taxFromItems(nextItems);

  const checkoutLines = await loadCheckoutLinesForItems(nextItems);
  const dimsAgg = aggregateShipping(checkoutLines);
  const weightSnapshot = buildShippingWeightSnapshotFromCheckoutLines({
    lines: checkoutLines,
    totalWeightKg: dimsAgg.weightKg,
    dims: {
      lengthCm: dimsAgg.lengthCm,
      widthCm: dimsAgg.widthCm,
      heightCm: dimsAgg.heightCm
    }
  });

  const provisionalTotalWithOldShip = roundMoney2(subtotal + oldDelivery + tax - discount);
  const codPass1 = estimateCodAmount(order, provisionalTotalWithOldShip, amountPaidInr);

  const ship = await ShiprocketService.checkDeliveryAvailability(postalCode, {
    weightKg: dimsAgg.weightKg,
    lengthCm: dimsAgg.lengthCm,
    widthCm: dimsAgg.widthCm,
    heightCm: dimsAgg.heightCm,
    codAmount: codPass1
  });

  if (!ship.isDeliverable) {
    throw createEditError(
      400,
      'NOT_SERVICEABLE',
      ship.message || 'Delivery not available for this pincode after item changes'
    );
  }

  const quotedDelivery = roundMoney2(Number(ship.deliveryCharges) || 0);
  // Never charge the customer more than previously quoted shipping.
  const customerDelivery = roundMoney2(Math.min(oldDelivery, quotedDelivery));

  const totalAmount = roundMoney2(subtotal + customerDelivery + tax - discount);
  const courierCompanyId =
    ship.courierCompanyId != null && Number.isFinite(Number(ship.courierCompanyId))
      ? Number(ship.courierCompanyId)
      : null;

  return {
    subtotal,
    tax,
    discount,
    oldDelivery,
    quotedDelivery,
    customerDelivery,
    shippingIncreasedAbsorbed: quotedDelivery > oldDelivery + 0.005,
    totalAmount,
    weightSnapshot,
    dimsAgg,
    shippingSnapshot: {
      courierName: ship.courierName || null,
      estimatedDays: ship.estimatedDays != null ? String(ship.estimatedDays) : null,
      courierCompanyId
    },
    shipMeta: {
      isDeliverable: ship.isDeliverable,
      codAvailable: ship.codAvailable !== false,
      mock: Boolean(ship.mock)
    }
  };
}

function settleFinancials(order, newTotal) {
  const amountPaidInr = roundMoney2(Number(order.amountPaidInr) || 0);
  const alreadyRefundedInr = roundMoney2(
    (order.refundHistory || []).reduce((s, r) => s + (Number(r.amountInr) || 0), 0)
  );
  const netCapturedInr = roundMoney2(Math.max(0, amountPaidInr - alreadyRefundedInr));
  const paymentStatus = String(order.paymentStatus || '').toLowerCase();
  const method = String(order.paymentInfo?.method || '').toLowerCase();

  if (method === 'cod') {
    return {
      refundInr: 0,
      balanceDueInr: roundMoney2(Math.max(0, newTotal)),
      amountPaidInr,
      paymentStatus: paymentStatus || 'pending',
      netCapturedInr
    };
  }

  // Online / prepaid with nothing captured yet — only reprice; no refund.
  const capturedStatuses = new Set(['paid', 'partially_paid', 'partially_refunded']);
  if (netCapturedInr <= 0.01 && !capturedStatuses.has(paymentStatus)) {
    return {
      refundInr: 0,
      balanceDueInr: roundMoney2(Math.max(0, newTotal)),
      amountPaidInr: 0,
      paymentStatus: paymentStatus || 'pending',
      netCapturedInr: 0
    };
  }

  if (netCapturedInr + 0.005 >= newTotal) {
    // Fully covered (full paid, or advance now covers new total). Refund any excess.
    const refundInr = roundMoney2(Math.max(0, Math.min(netCapturedInr, netCapturedInr - newTotal)));
    return {
      refundInr,
      balanceDueInr: 0,
      // After successful refund we persist amountPaidInr = newTotal (see commit path).
      amountPaidInr: newTotal,
      paymentStatus: 'paid',
      netCapturedInr
    };
  }

  // Partial advance still outstanding
  return {
    refundInr: 0,
    balanceDueInr: roundMoney2(newTotal - netCapturedInr),
    amountPaidInr,
    paymentStatus: 'partially_paid',
    netCapturedInr
  };
}

function buildCustomerMessages({
  changeSummaries,
  refundInr,
  balanceDueInr,
  cancelledEmpty,
  newTotal,
  shippingSettlementDeferred = false
}) {
  const notes = [];
  const itemParts = (changeSummaries || []).map((c) => {
    if (c.action === 'removed') {
      return `"${c.productName}" was unavailable and removed from your order`;
    }
    return `"${c.productName}" quantity was reduced from ${c.oldQuantity} to ${c.newQuantity} due to limited stock`;
  });
  const itemNames = (changeSummaries || [])
    .map((c) => c.productName)
    .filter(Boolean);

  if (cancelledEmpty) {
    const namesBit =
      itemNames.length === 1
        ? `"${itemNames[0]}" was not available`
        : itemNames.length > 1
          ? `these items were not available: ${itemNames.map((n) => `"${n}"`).join(', ')}`
          : 'no items remained available';
    const msg =
      refundInr > 0.005
        ? `Your order was cancelled because ${namesBit}. A refund of ₹${formatInrDisplay(refundInr)} has been processed.`
        : `Your order was cancelled because ${namesBit}.`;
    notes.push({
      message: msg,
      kind: 'order_cancelled_empty',
      metadata: { refundInr, cancelledEmpty: true, changes: changeSummaries }
    });
    return notes;
  }

  if (itemParts.length) {
    let message = `${itemParts.join('. ')}.`;
    if (refundInr > 0.005) {
      message += shippingSettlementDeferred
        ? ` A refund of ₹${formatInrDisplay(refundInr)} will be processed after your shipment is booked with the courier (final shipping applied then).`
        : ` A refund of ₹${formatInrDisplay(refundInr)} has been processed for the unavailable item(s) and any reduced shipping charges.`;
      notes.push({
        message,
        kind: 'item_unavailable_refund',
        metadata: {
          refundInr,
          balanceDueInr,
          newTotal,
          changes: changeSummaries,
          shippingSettlementDeferred: Boolean(shippingSettlementDeferred)
        }
      });
    } else {
      if (shippingSettlementDeferred) {
        message += ` Your updated items are saved. Final total and any refund will be calculated after courier assignment (Ship Now).`;
        if (balanceDueInr > 0.005) {
          message += ` Current balance due is ₹${formatInrDisplay(balanceDueInr)} (will not increase).`;
        }
      } else if (balanceDueInr > 0.005) {
        message += ` Your updated order total is ₹${formatInrDisplay(newTotal)}. COD / balance due is now ₹${formatInrDisplay(balanceDueInr)}.`;
      } else {
        message += ` Your updated order total is ₹${formatInrDisplay(newTotal)}.`;
      }
      notes.push({
        message,
        kind: 'order_amended',
        metadata: {
          refundInr: 0,
          balanceDueInr,
          newTotal,
          changes: changeSummaries,
          shippingSettlementDeferred: Boolean(shippingSettlementDeferred)
        }
      });
    }
  }

  return notes;
}

/**
 * Snapshot lines being removed (for customer history UI).
 */
function buildRemovedArchiveEntries(order, changeSummaries, reason = 'unavailable') {
  const existing = Array.isArray(order.items) ? order.items : [];
  const weightLines = order.shippingWeightSnapshot?.lines || [];
  const entries = [];

  for (const change of changeSummaries || []) {
    if (change.action !== 'removed' && change.action !== 'qty_reduced') continue;
    const key = lineKey(change.productId, change.variantId);
    const item = existing.find((it) => {
      const pid = it.productId?._id || it.productId;
      const vid = it.variantId?._id || it.variantId;
      return lineKey(pid, vid) === key;
    });
    const snapLine = weightLines.find((l) => lineKey(l.productId, l.variantId) === key);
    const removedQty =
      change.action === 'removed'
        ? Number(change.oldQuantity) || Number(item?.quantity) || 0
        : Math.max(0, (Number(change.oldQuantity) || 0) - (Number(change.newQuantity) || 0));
    if (!(removedQty > 0)) continue;

    const unit = item ? unitSalePrice(item) : roundMoney2((Number(change.amountRemovedInr) || 0) / removedQty);
    entries.push({
      productId: change.productId || item?.productId?._id || item?.productId || null,
      variantId: change.variantId || item?.variantId?._id || item?.variantId || null,
      productName: change.productName || snapLine?.productName || item?.productId?.name || 'Product',
      sku: snapLine?.sku || null,
      quantity: removedQty,
      priceSnapshot: {
        base: Number(item?.priceSnapshot?.base) || unit,
        sale: item?.priceSnapshot?.sale != null ? Number(item.priceSnapshot.sale) : unit,
        total: roundMoney2(unit * removedQty)
      },
      reason: change.action === 'qty_reduced' ? 'qty_reduced' : reason,
      removedAt: new Date()
    });
  }
  return entries;
}

async function attemptAmendmentRefund(order, refundInr, reason) {
  if (!(refundInr > 0.005)) {
    return { refundAttempted: false, refund: null, warning: null };
  }
  const paymentId = order.paymentInfo?.razorpayPaymentId;
  if (!paymentId || !razorpay) {
    return {
      refundAttempted: false,
      refund: null,
      warning: 'Refund amount is due but Razorpay is not configured or payment id is missing.'
    };
  }

  const paise = Math.round(refundInr * 100);
  if (paise < 1) {
    return { refundAttempted: false, refund: null, warning: null };
  }

  try {
    const refund = await razorpay.payments.refund(paymentId, {
      amount: paise,
      speed: 'normal',
      notes: {
        orderId: order.orderId,
        reason: reason || 'order_amended_item_unavailable'
      }
    });

    const amountPaise = Number(refund.amount);
    const amountInr = roundMoney2(amountPaise / 100);
    order.refundHistory = order.refundHistory || [];
    if (!order.refundHistory.some((r) => r.refundId === refund.id)) {
      order.refundHistory.push({
        refundId: refund.id,
        amountInr,
        amountPaise,
        status: refund.status || 'processed',
        reason: reason || 'order_amended_item_unavailable',
        createdAt: new Date()
      });
    }
    order.markModified('refundHistory');
    return { refundAttempted: true, refund, warning: null };
  } catch (err) {
    logger.error('[adminPendingOrderEdit] refund failed', {
      orderId: order.orderId,
      message: err?.message
    });
    return {
      refundAttempted: true,
      refund: null,
      warning: err?.error?.description || err?.message || 'Refund API failed'
    };
  }
}

/**
 * Preview or apply item edits.
 * @param {{ orderId: string, itemUpdates: array, commit?: boolean, adminUserId?: unknown }} opts
 */
async function previewOrApplyPendingOrderEdit(opts) {
  const orderId = String(opts.orderId || '').trim();
  const itemUpdates = opts.itemUpdates;
  const commit = Boolean(opts.commit);
  const adminUserId = opts.adminUserId || null;
  const scopeMatch = opts.scopeMatch || null;

  if (!orderId) {
    throw createEditError(400, 'ORDER_ID_REQUIRED', 'orderId is required');
  }

  const { mergeOrderScopeFilter } = require('../utils/adminOrderScope');
  const order = await Order.findOne(mergeOrderScopeFilter({ orderId }, scopeMatch)).populate(
    'items.productId',
    'name slug'
  );
  assertEditablePendingOrder(order);

  const before = snapshotMoney(order);
  const { nextItems, releasedLines, changeSummaries } = applyItemUpdatesToOrderItems(order, itemUpdates);

  // ——— Empty order → cancel + refund paid ———
  if (nextItems.length === 0) {
    const paidNet = roundMoney2(
      Math.max(
        0,
        roundMoney2(Number(order.amountPaidInr) || 0) -
          roundMoney2((order.refundHistory || []).reduce((s, r) => s + (Number(r.amountInr) || 0), 0))
      )
    );
    const customerNotes = buildCustomerMessages({
      changeSummaries,
      refundInr: paidNet,
      balanceDueInr: 0,
      cancelledEmpty: true,
      newTotal: before.totalAmount
    });
    const archiveEntries = buildRemovedArchiveEntries(order, changeSummaries, 'order_cancelled_empty');

    const preview = {
      orderId,
      cancelledEmpty: true,
      changes: changeSummaries,
      before,
      after: {
        ...before,
        // Keep original line items + totals for customer history; only close the order.
        amountPaidInr: paidNet > 0.005 ? 0 : before.amountPaidInr,
        balanceDueInr: 0,
        paymentStatus: paidNet > 0.005 ? 'refunded' : before.paymentStatus,
        orderStatus: 'cancelled'
      },
      refundInr: paidNet,
      shipping: {
        oldDelivery: before.deliveryCharges,
        quotedDelivery: before.deliveryCharges,
        customerDelivery: before.deliveryCharges,
        shippingIncreasedAbsorbed: false
      },
      customerNotes,
      commit: false
    };

    if (!commit) {
      return { success: true, preview };
    }

    // Apply cancel — preserve items + money for UX history (do not wipe).
    const originalItemsForStock = (order.items || []).map((it) => ({
      productId: it.productId?._id || it.productId,
      variantId: it.variantId?._id || it.variantId,
      quantity: it.quantity
    }));

    order.balanceDueInr = 0;
    order.orderStatus = 'cancelled';
    order.paymentInfo = order.paymentInfo || {};
    order.paymentInfo.cancellationReason = 'admin_amended_empty';
    order.paymentInfo.cancelledAt = new Date();
    order.paymentInfo.itemsUnavailableCancel = true;
    order.markModified('paymentInfo');

    if (archiveEntries.length) {
      order.removedItemsArchive = [...(order.removedItemsArchive || []), ...archiveEntries];
      order.markModified('removedItemsArchive');
    }

    const refundOutcome = await attemptAmendmentRefund(
      order,
      paidNet,
      'order_cancelled_all_items_unavailable'
    );
    if (paidNet > 0.005 && !refundOutcome.warning) {
      order.paymentStatus = 'refunded';
      order.amountPaidInr = 0;
      order.returnInfo = mergeReturnInfo(order.returnInfo, {
        refundContext: 'cancellation',
        status: 'refunded',
        refundAmount: paidNet,
        refundId: refundOutcome.refund?.id || order.returnInfo?.refundId,
        approvedAt: new Date()
      });
    } else if (paidNet > 0.005 && refundOutcome.warning) {
      order.paymentStatus = String(order.paymentStatus || 'partially_paid');
      order.returnInfo = mergeReturnInfo(order.returnInfo, {
        refundContext: 'cancellation',
        status: 'refund_failed',
        refundAmount: paidNet
      });
    } else {
      const method = String(order.paymentInfo?.method || '').toLowerCase();
      if (method === 'online') order.paymentStatus = 'failed';
      order.returnInfo = mergeReturnInfo(order.returnInfo, {
        refundContext: 'cancellation',
        status: 'not_required'
      });
    }

    for (const note of customerNotes) {
      order.customerFacingNotes = order.customerFacingNotes || [];
      order.customerFacingNotes.push({
        message: note.message,
        kind: note.kind,
        createdAt: new Date(),
        metadata: note.metadata || null
      });
    }
    order.markModified('customerFacingNotes');
    order.adminEditHistory = order.adminEditHistory || [];
    order.adminEditHistory.push({
      action: 'cancel_empty_after_edit',
      note: 'All items unavailable — order cancelled (items preserved for history)',
      performedBy: adminUserId,
      createdAt: new Date(),
      before,
      after: snapshotMoney(order),
      metadata: { changes: changeSummaries, refundWarning: refundOutcome.warning }
    });
    order.markModified('adminEditHistory');

    await order.save();
    const hold = readHold(order);
    if (hold.inventoryReserved || hold.source === 'inventory' || hold.source === 'hybrid') {
      await releaseOrderStockHold(order);
      await order.save();
    } else {
      await releaseReservedInventoryForLines(originalItemsForStock);
    }

    try {
      await notifyOrderAmended(order, customerNotes[0]?.message, {
        refundInr: paidNet,
        cancelledEmpty: true,
        newTotal: before.totalAmount
      });
    } catch (notifyErr) {
      logger.warn('[adminPendingOrderEdit] notify failed', { message: notifyErr.message });
    }

    return {
      success: true,
      committed: true,
      cancelledEmpty: true,
      orderId,
      changes: changeSummaries,
      before,
      after: snapshotMoney(order),
      refundInr: paidNet,
      refundWarning: refundOutcome.warning,
      customerNotes,
      orderStatus: order.orderStatus,
      paymentStatus: order.paymentStatus
    };
  }

  const pricedRaw = await repriceShippingForItems(order, nextItems);
  const deferShipping = shouldDeferShippingSettlement(order, pricedRaw);

  // Online/prepaid: keep prior delivery until Ship Now; NO Razorpay refund on Apply.
  // Final bill uses actual Shiprocket freight (held fallback); due/COD never increases (policy v3).
  const priced = deferShipping
    ? {
        ...pricedRaw,
        customerDelivery: pricedRaw.oldDelivery,
        totalAmount: roundMoney2(
          pricedRaw.subtotal + pricedRaw.oldDelivery + pricedRaw.tax - pricedRaw.discount
        ),
        shippingSettlementDeferred: true
      }
    : { ...pricedRaw, shippingSettlementDeferred: false };

  const settlement = deferShipping
    ? computeDeferredApplyFinancials(order, priced.totalAmount)
    : settleFinancials(order, priced.totalAmount);

  const customerNotes = buildCustomerMessages({
    changeSummaries,
    refundInr: settlement.refundInr,
    balanceDueInr: settlement.balanceDueInr,
    cancelledEmpty: false,
    newTotal: priced.totalAmount,
    shippingSettlementDeferred: deferShipping
  });

  const afterPreview = {
    subtotal: priced.subtotal,
    deliveryCharges: priced.customerDelivery,
    tax: priced.tax,
    discount: priced.discount,
    totalAmount: priced.totalAmount,
    amountPaidInr: settlement.amountPaidInr,
    balanceDueInr: settlement.balanceDueInr,
    paymentStatus: settlement.paymentStatus,
    shippingSnapshot: priced.shippingSnapshot,
    weightKg: priced.dimsAgg.weightKg
  };

  const preview = {
    orderId,
    cancelledEmpty: false,
    changes: changeSummaries,
    before,
    after: afterPreview,
    refundInr: settlement.refundInr,
    refundDeferredUntilShipNow: deferShipping,
    shippingSettlementDeferred: deferShipping,
    shipping: {
      oldDelivery: priced.oldDelivery,
      quotedDelivery: priced.quotedDelivery,
      customerDelivery: priced.customerDelivery,
      shippingIncreasedAbsorbed: priced.shippingIncreasedAbsorbed,
      shippingSettlementDeferred: deferShipping,
      provisionalEstimateOnly: deferShipping,
      courierName: priced.shippingSnapshot.courierName,
      courierCompanyId: priced.shippingSnapshot.courierCompanyId,
      estimatedDays: priced.shippingSnapshot.estimatedDays,
      quotedMock: Boolean(priced.shipMeta?.mock)
    },
    customerNotes,
    remainingItems: nextItems.map((it) => ({
      productId: String(it.productId),
      variantId: String(it.variantId),
      quantity: it.quantity,
      lineTotal: it.priceSnapshot.total
    })),
    commit: false
  };

  if (!commit) {
    return { success: true, preview };
  }

  // ——— Commit amendment ———
  const priorAmountPaidInr = roundMoney2(Number(order.amountPaidInr) || 0);
  const priorPaymentStatus = order.paymentStatus;
  const priorBalanceDueInr = roundMoney2(Number(order.balanceDueInr) || 0);

  const archiveEntries = buildRemovedArchiveEntries(order, changeSummaries, 'unavailable');
  if (archiveEntries.length) {
    order.removedItemsArchive = [...(order.removedItemsArchive || []), ...archiveEntries];
    order.markModified('removedItemsArchive');
  }

  order.items = nextItems;
  order.subtotal = priced.subtotal;
  order.deliveryCharges = priced.customerDelivery;
  order.tax = priced.tax;
  // discount frozen
  order.discount = priced.discount;
  if (order.appliedCoupon && typeof order.appliedCoupon === 'object') {
    order.appliedCoupon.discount = priced.discount;
    order.markModified('appliedCoupon');
  }
  order.totalAmount = priced.totalAmount;
  order.shippingSnapshot = priced.shippingSnapshot;
  order.shippingWeightSnapshot = priced.weightSnapshot;
  order.paymentInfo = order.paymentInfo || {};
  order.paymentInfo.fullOrderAmountPaise = Math.round(priced.totalAmount * 100);
  if (deferShipping) {
    // Snapshot caps BEFORE mutating due/paid on this save path
    order.balanceDueInr = priorBalanceDueInr;
    order.amountPaidInr = priorAmountPaidInr;
    order.paymentInfo.oosShippingSettlement = buildOosShippingSettlementMeta(
      {
        amountPaidInr: priorAmountPaidInr,
        balanceDueInr: priorBalanceDueInr
      },
      pricedRaw
    );
    order.amountPaidInr = settlement.amountPaidInr;
    order.balanceDueInr = settlement.balanceDueInr;
    order.paymentStatus = settlement.paymentStatus;
  } else if (order.paymentInfo.oosShippingSettlement?.pending) {
    order.paymentInfo.oosShippingSettlement = {
      ...order.paymentInfo.oosShippingSettlement,
      pending: false,
      clearedAt: new Date().toISOString(),
      clearReason: 'non_deferred_amendment'
    };
  }
  order.markModified('paymentInfo');
  order.markModified('items');
  order.markModified('shippingSnapshot');
  order.markModified('shippingWeightSnapshot');

  let refundOutcome = { refundAttempted: false, refund: null, warning: null };

  if (deferShipping) {
    // Money settle only after Ship Now (actual freight).
    refundOutcome = { refundAttempted: false, refund: null, warning: null };
  } else {
    refundOutcome = await attemptAmendmentRefund(
      order,
      settlement.refundInr,
      'order_amended_item_unavailable'
    );

    if (settlement.refundInr > 0.005 && refundOutcome.warning) {
      order.amountPaidInr = priorAmountPaidInr;
      order.balanceDueInr = 0;
      order.paymentStatus = priorPaymentStatus === 'partially_paid' ? 'partially_paid' : 'paid';
      order.paymentInfo.amendmentRefundFailureReason = refundOutcome.warning;
      order.markModified('paymentInfo');
    } else if (settlement.refundInr > 0.005 && refundOutcome.refund) {
      order.amountPaidInr = priced.totalAmount;
      order.balanceDueInr = 0;
      order.paymentStatus = 'paid';
      order.returnInfo = mergeReturnInfo(order.returnInfo, {
        refundContext: 'cancellation',
        status: 'partially_refunded',
        refundAmount: roundMoney2(
          (order.refundHistory || []).reduce((s, r) => s + (Number(r.amountInr) || 0), 0)
        ),
        refundId: refundOutcome.refund.id
      });
      order.markModified('returnInfo');
    } else {
      order.amountPaidInr = settlement.amountPaidInr;
      order.balanceDueInr = settlement.balanceDueInr;
      order.paymentStatus = settlement.paymentStatus;
    }
  }

  for (const note of customerNotes) {
    order.customerFacingNotes = order.customerFacingNotes || [];
    order.customerFacingNotes.push({
      message: note.message,
      kind: note.kind,
      createdAt: new Date(),
      metadata: note.metadata || null
    });
  }
  order.markModified('customerFacingNotes');

  order.adminEditHistory = order.adminEditHistory || [];
  order.adminEditHistory.push({
    action: 'pending_order_items_edited',
    note: deferShipping
      ? 'Pending order items amended — money settlement deferred until Ship Now (actual freight)'
      : 'Pending order items amended before accept',
    performedBy: adminUserId,
    createdAt: new Date(),
    before,
    after: snapshotMoney(order),
    metadata: {
      changes: changeSummaries,
      shipping: preview.shipping,
      refundInr: settlement.refundInr,
      refundWarning: refundOutcome.warning,
      shippingSettlementDeferred: deferShipping,
      refundDeferredUntilShipNow: deferShipping
    }
  });
  order.markModified('adminEditHistory');

  await order.save();

  const hold = readHold(order);
  if (hold.inventoryReserved || hold.source === 'inventory' || hold.source === 'hybrid') {
    await syncHoldAfterPendingOrderEdit(order);
    await order.save();
  } else if (releasedLines.length) {
    await releaseReservedInventoryForLines(releasedLines);
  }

  try {
    await notifyOrderAmended(order, customerNotes[0]?.message, {
      refundInr: settlement.refundInr,
      balanceDueInr: order.balanceDueInr,
      newTotal: order.totalAmount
    });
  } catch (notifyErr) {
    logger.warn('[adminPendingOrderEdit] notify failed', { message: notifyErr.message });
  }

  return {
    success: true,
    committed: true,
    cancelledEmpty: false,
    orderId,
    changes: changeSummaries,
    before,
    after: snapshotMoney(order),
    refundInr: settlement.refundInr,
    refundWarning: refundOutcome.warning,
    refundDeferredUntilShipNow: deferShipping,
    shipping: preview.shipping,
    shippingSettlementDeferred: deferShipping,
    customerNotes,
    orderStatus: order.orderStatus,
    paymentStatus: order.paymentStatus
  };
}

module.exports = {
  previewOrApplyPendingOrderEdit,
  assertEditablePendingOrder,
  createEditError,
  repriceShippingForItems,
  settleFinancials,
  attemptAmendmentRefund,
  snapshotMoney
};
