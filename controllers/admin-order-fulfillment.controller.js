/**
 * Admin-only Shiprocket fulfillment: ensure create, assign AWB (ship), scheduled pickup, label, cancel.
 * Uses shared shipment sync from order.controller.
 */

const Order = require('../models/Order');
const ShiprocketService = require('../utils/shiprocket');
const logger = require('../utils/logger');
const { isOrderStaffRequest } = require('../utils/checkoutFlow');
const { buildGstInvoiceHtml, buildGstInvoiceViewModel } = require('../utils/gstInvoice');
const { applyUpsertShipmentInfo, ensureShipmentForOrderExport } = require('./order.controller');
const {
  evaluateOrderPaymentForShiprocketFulfillment,
  fulfillmentPaymentBlockHttpStatus
} = require('../utils/orderFulfillmentPaymentGate');

function jsonError(res, status, code, message, extras = {}) {
  return res.status(status).json({ success: false, code, message, ...extras });
}

async function loadStaffOrder(req, res, orderId) {
  if (!isOrderStaffRequest(req)) {
    jsonError(res, 403, 'ORDER_ADMIN_ACCESS_REQUIRED', 'Admin access required');
    return null;
  }
  const id = String(orderId || '').trim();
  if (!id) {
    jsonError(res, 400, 'ORDER_ID_REQUIRED', 'orderId is required');
    return null;
  }
  const order = await Order.findOne({ orderId: id }).populate('items.productId', 'name slug shipping');
  if (!order) {
    jsonError(res, 404, 'ORDER_NOT_FOUND', 'Order not found');
    return null;
  }
  return order;
}

/** Block Shiprocket mutations when online settlement does not yet allow fulfilment. */
function requireFulfillmentPaymentReady(order, res) {
  const gate = evaluateOrderPaymentForShiprocketFulfillment(order);
  if (gate.ok) return true;
  jsonError(res, fulfillmentPaymentBlockHttpStatus(gate.code), gate.code, gate.message, {
    details: gate.details || null
  });
  return false;
}

function pickupDateNotInPast(pickupDateYmd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(pickupDateYmd || '').trim());
  if (!m) return { ok: false, message: 'pickupDate must be YYYY-MM-DD' };
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const chosen = new Date(Date.UTC(y, mo, d));
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (chosen < today) {
    return { ok: false, message: 'pickupDate cannot be in the past' };
  }
  return { ok: true };
}

const MAX_BULK_ORDER_IDS = 50;
const DEFAULT_BULK_CONCURRENCY = 4;
const FULFILLMENT_ITEM_POPULATE = { path: 'items.productId', select: 'name slug shipping' };

async function loadOrderDocByOrderId(orderId) {
  const id = String(orderId || '').trim();
  if (!id) return null;
  return Order.findOne({ orderId: id }).populate(FULFILLMENT_ITEM_POPULATE);
}

function parseBulkConcurrency(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_BULK_CONCURRENCY;
  return Math.min(8, Math.max(1, Math.floor(n)));
}

function assertStaffJson(req, res) {
  if (!isOrderStaffRequest(req)) {
    jsonError(res, 403, 'ORDER_ADMIN_ACCESS_REQUIRED', 'Admin access required');
    return false;
  }
  return true;
}

/**
 * Process ids in windows of `parallel` concurrent handlers (deterministic order).
 * @template R
 * @param {string[]} ids
 * @param {number} parallel
 * @param {(id: string) => Promise<R>} handler
 */
async function mapInConcurrentWindows(ids, parallel, handler) {
  const out = [];
  const limit = Math.min(Math.max(1, parallel), ids.length || 1);
  for (let i = 0; i < ids.length; i += limit) {
    const window = ids.slice(i, i + limit);
    const batch = await Promise.all(
      window.map((id) =>
        handler(id).catch((err) => ({
          orderId: id,
          success: false,
          skipped: false,
          code: 'UNHANDLED',
          message: err?.message || String(err)
        }))
      )
    );
    out.push(...batch);
  }
  return out;
}

/**
 * @param {import('mongoose').Document} order
 * @param {number|null|undefined} courierIdOverride
 */
async function runAssignShipFromOrder(order, courierIdOverride) {
  try {
    const shipmentId = order.shipmentInfo?.shipmentId;
    if (!shipmentId) {
      return { success: false, code: 'SHIPMENT_ID_MISSING', message: 'Create/push shipment first (no shipment_id on order).' };
    }
    if (order.shipmentInfo?.awbCode || order.shipmentInfo?.trackingNumber) {
      return { success: false, code: 'AWB_ALREADY_ASSIGNED', message: 'AWB already assigned for this order.' };
    }

    const parts = await ShiprocketService.buildAdhocPayloadParts(order);
    const deliveryPin = String(parts.addr?.postalCode || '').replace(/\D/g, '').slice(0, 6);
    if (deliveryPin.length !== 6) {
      return { success: false, code: 'INVALID_DELIVERY_PINCODE', message: 'Order address must include a 6-digit delivery pincode.' };
    }

    let courierId = courierIdOverride != null ? Number(courierIdOverride) : null;
    if (courierId != null && !Number.isFinite(courierId)) {
      return { success: false, code: 'INVALID_COURIER_ID', message: 'courierId must be a number when provided.' };
    }

    if (courierId == null && order.shippingSnapshot?.courierCompanyId != null) {
      const q = Number(order.shippingSnapshot.courierCompanyId);
      if (Number.isFinite(q) && q > 0) {
        courierId = q;
      }
    }

    if (courierId == null) {
      const listRes = await ShiprocketService.listCouriersForRoute(deliveryPin, {
        weightKg: parts.totalWeight,
        lengthCm: parts.maxL,
        widthCm: parts.maxB,
        heightCm: parts.maxH,
        codAmount: parts.codAmountForQuote
      });
      if (!listRes.success) {
        return {
          success: false,
          code: 'COURIER_LIST_FAILED',
          message: listRes.message || 'Could not list couriers',
          details: listRes
        };
      }
      courierId = ShiprocketService.pickRecommendedCourierId(listRes.couriers || [], {
        codRequired: parts.useCodAtDoor
      });
      if (courierId == null) {
        return { success: false, code: 'NO_COURIER_SELECTED', message: 'No suitable courier_id could be selected.' };
      }
    }

    const assign = await ShiprocketService.assignAwb({
      shipmentId,
      courierId
    });
    if (!assign.success) {
      return {
        success: false,
        code: assign.code || 'ASSIGN_AWB_FAILED',
        message: assign.message || 'Assign AWB failed',
        details: assign.details || null
      };
    }

    await applyUpsertShipmentInfo({
      order,
      shipmentPayload: {
        ...assign,
        assignedCourierId: String(courierId),
        shiprocketOrderId: order.shipmentInfo?.shiprocketOrderId || undefined
      },
      trigger: 'admin_assign_awb',
      allowOrderStatusUpdate: Boolean(assign.awbCode || assign.trackingNumber)
    });

    let fresh = await Order.findOne({ orderId: order.orderId });
    const hasAwb = Boolean(fresh?.shipmentInfo?.awbCode || fresh?.shipmentInfo?.trackingNumber);
    if (hasAwb && ['pending', 'confirmed'].includes(String(fresh.orderStatus || '').toLowerCase())) {
      fresh.orderStatus = 'processing';
      await fresh.save();
      fresh = await Order.findOne({ orderId: order.orderId });
    }

    return {
      success: true,
      message: 'Courier assigned and AWB generated',
      courierId,
      shipment: assign,
      order: fresh
    };
  } catch (err) {
    logger.error('runAssignShipFromOrder', { orderId: order?.orderId, message: err?.message, stack: err?.stack });
    return { success: false, code: 'ASSIGN_INTERNAL_ERROR', message: err?.message || 'Assign failed' };
  }
}

/**
 * Single-order ship-now pipeline for bulk (ensure + assign when needed). Caller does not hold a DB session.
 * @param {string} orderId
 * @param {{ courierId?: number|null }} [opts]
 */
async function runBulkShipNowSingle(orderId, opts = {}) {
  try {
    const id = String(orderId || '').trim();
    if (!id) {
      return { orderId: orderId || '', success: false, skipped: false, code: 'ORDER_ID_REQUIRED', message: 'orderId is required' };
    }

    const order = await loadOrderDocByOrderId(id);
  if (!order) {
    return { orderId: id, success: false, skipped: false, code: 'ORDER_NOT_FOUND', message: 'Order not found' };
  }

  const status = String(order.orderStatus || '').toLowerCase();
  if (status !== 'confirmed') {
    return {
      orderId: id,
      success: false,
      skipped: false,
      code: 'ORDER_STATUS_NOT_ELIGIBLE',
      message: `Bulk ship is allowed only for confirmed orders (current: ${order.orderStatus || 'unknown'}).`
    };
  }

  const gate = evaluateOrderPaymentForShiprocketFulfillment(order);
  if (!gate.ok) {
    return {
      orderId: id,
      success: false,
      skipped: false,
      code: gate.code || 'PAYMENT_REQUIRED',
      message: gate.message || 'Payment requirements not met for shipment.'
    };
  }

  const hasAwb = Boolean(order.shipmentInfo?.awbCode || order.shipmentInfo?.trackingNumber);
  if (hasAwb) {
    return {
      orderId: id,
      success: true,
      skipped: true,
      code: 'ALREADY_SHIPPED',
      message: 'AWB already assigned — nothing to do.'
    };
  }

  const ensureResult = await ensureShipmentForOrderExport({ order, trigger: 'admin_bulk_ship_now' });
  if (!ensureResult.success) {
    return {
      orderId: id,
      success: false,
      skipped: false,
      code: ensureResult.code || 'SHIPMENT_ENSURE_FAILED',
      message: ensureResult.message || 'Shipment ensure/create failed',
      details: ensureResult.details || null
    };
  }

  let working = await loadOrderDocByOrderId(id);
  if (!working) {
    return { orderId: id, success: false, skipped: false, code: 'ORDER_RELOAD_FAILED', message: 'Could not reload order after ensure.' };
  }

  const si = working.shipmentInfo || {};
  if (si.awbCode || si.trackingNumber) {
    return { orderId: id, success: true, skipped: false, code: null, message: 'Shipment ready with AWB after ensure.' };
  }

  if (!si.shipmentId) {
    return {
      orderId: id,
      success: false,
      skipped: false,
      code: 'NO_SHIPMENT_ID',
      message: 'Shiprocket did not return a shipment_id; cannot assign AWB.'
    };
  }

  const assignRes = await runAssignShipFromOrder(working, opts.courierId);
  if (!assignRes.success) {
    return {
      orderId: id,
      success: false,
      skipped: false,
      code: assignRes.code || 'ASSIGN_AWB_FAILED',
      message: assignRes.message || 'Assign AWB failed',
      details: assignRes.details || null
    };
  }

  return {
    orderId: id,
    success: true,
    skipped: false,
    code: null,
    message: assignRes.message || 'Ship now completed.',
    courierId: assignRes.courierId
  };
  } catch (err) {
    logger.error('runBulkShipNowSingle', { orderId, message: err?.message, stack: err?.stack });
    return {
      orderId: String(orderId || '').trim() || String(orderId),
      success: false,
      skipped: false,
      code: 'UNHANDLED',
      message: err?.message || String(err)
    };
  }
}

/**
 * @param {string} orderId
 * @param {string} pickupDateYmd
 */
async function runBulkSchedulePickupSingle(orderId, pickupDateYmd) {
  try {
  const id = String(orderId || '').trim();
  const pickupDate = String(pickupDateYmd || '').trim();
  if (!id) {
    return { orderId: orderId || '', success: false, skipped: false, code: 'ORDER_ID_REQUIRED', message: 'orderId is required' };
  }

  const order = await loadOrderDocByOrderId(id);
  if (!order) {
    return { orderId: id, success: false, skipped: false, code: 'ORDER_NOT_FOUND', message: 'Order not found' };
  }

  const status = String(order.orderStatus || '').toLowerCase();
  if (!['confirmed', 'processing'].includes(status)) {
    return {
      orderId: id,
      success: false,
      skipped: false,
      code: 'ORDER_STATUS_NOT_ELIGIBLE',
      message: `Pickup scheduling requires confirmed or processing orders (current: ${order.orderStatus || 'unknown'}).`
    };
  }

  const gate = evaluateOrderPaymentForShiprocketFulfillment(order);
  if (!gate.ok) {
    return {
      orderId: id,
      success: false,
      skipped: false,
      code: gate.code || 'PAYMENT_REQUIRED',
      message: gate.message || 'Payment requirements not met.'
    };
  }

  const shipmentId = order.shipmentInfo?.shipmentId;
  if (!shipmentId) {
    return { orderId: id, success: false, skipped: false, code: 'SHIPMENT_ID_MISSING', message: 'No shipment_id on order.' };
  }
  if (!(order.shipmentInfo?.awbCode || order.shipmentInfo?.trackingNumber)) {
    return { orderId: id, success: false, skipped: false, code: 'AWB_REQUIRED', message: 'Assign AWB before scheduling pickup.' };
  }

  if (order.shipmentInfo?.pickupScheduledAt || order.shipmentInfo?.pickupDate) {
    return {
      orderId: id,
      success: true,
      skipped: true,
      code: 'PICKUP_ALREADY_SET',
      message: 'Pickup already recorded for this order.'
    };
  }

  const dateCheck = pickupDateNotInPast(pickupDate);
  if (!dateCheck.ok) {
    return { orderId: id, success: false, skipped: false, code: 'INVALID_PICKUP_DATE', message: dateCheck.message };
  }

  const sched = await ShiprocketService.schedulePickup({ shipmentId, pickupDate });
  if (!sched.success) {
    order.shipmentInfo = { ...(order.shipmentInfo || {}), lastPickupError: sched.message || 'pickup failed' };
    order.markModified('shipmentInfo');
    await order.save();
    return {
      orderId: id,
      success: false,
      skipped: false,
      code: sched.code || 'PICKUP_FAILED',
      message: sched.message || 'Pickup schedule failed',
      details: sched.details || null
    };
  }

  order.shipmentInfo = {
    ...(order.shipmentInfo || {}),
    pickupDate,
    pickupScheduledAt: new Date(),
    lastPickupError: null,
    providerStatus: sched.providerStatus || order.shipmentInfo?.providerStatus
  };
  order.markModified('shipmentInfo');
  await order.save();

  return { orderId: id, success: true, skipped: false, code: null, message: 'Pickup scheduled.' };
  } catch (err) {
    logger.error('runBulkSchedulePickupSingle', { orderId, message: err?.message, stack: err?.stack });
    return {
      orderId: String(orderId || '').trim() || String(orderId),
      success: false,
      skipped: false,
      code: 'UNHANDLED',
      message: err?.message || String(err)
    };
  }
}

/** POST /orders/admin/items/bulk-fulfillment/ship-now  body: { orderIds: string[], concurrency?: number, courierId?: number } */
exports.adminBulkFulfillmentShipNow = async (req, res) => {
  try {
    if (!assertStaffJson(req, res)) return;
    const rawIds = Array.isArray(req.body?.orderIds) ? req.body.orderIds : [];
    const seen = new Set();
    const orderIds = [];
    for (const x of rawIds) {
      const id = String(x || '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      orderIds.push(id);
      if (orderIds.length >= MAX_BULK_ORDER_IDS) break;
    }
    if (orderIds.length === 0) {
      return jsonError(res, 400, 'ORDER_IDS_REQUIRED', `Provide orderIds (non-empty array, max ${MAX_BULK_ORDER_IDS}).`);
    }

    const parallel = parseBulkConcurrency(req.body?.concurrency);
    const courierId = req.body?.courierId != null ? Number(req.body.courierId) : null;
    const courierOpt =
      courierId != null && Number.isFinite(courierId) && courierId > 0 ? { courierId } : {};

    const results = await mapInConcurrentWindows(orderIds, parallel, (oid) => runBulkShipNowSingle(oid, courierOpt));

    const succeeded = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);
    const skipped = succeeded.filter((r) => r.skipped);

    return res.json({
      success: true,
      summary: {
        total: results.length,
        succeeded: succeeded.length,
        failed: failed.length,
        skipped: skipped.length,
        completed: succeeded.filter((r) => !r.skipped).length
      },
      results
    });
  } catch (error) {
    logger.error('adminBulkFulfillmentShipNow', { message: error.message, stack: error.stack });
    return jsonError(res, 500, 'BULK_SHIP_NOW_FAILED', error.message || 'Server error');
  }
};

/** POST /orders/admin/items/bulk-fulfillment/schedule-pickup  body: { orderIds: string[], pickupDate: "YYYY-MM-DD", concurrency?: number } */
exports.adminBulkFulfillmentSchedulePickup = async (req, res) => {
  try {
    if (!assertStaffJson(req, res)) return;
    const pickupDate = String(req.body?.pickupDate || '').trim();
    const dateCheck = pickupDateNotInPast(pickupDate);
    if (!dateCheck.ok) {
      return jsonError(res, 400, 'INVALID_PICKUP_DATE', dateCheck.message);
    }

    const rawIds = Array.isArray(req.body?.orderIds) ? req.body.orderIds : [];
    const seen = new Set();
    const orderIds = [];
    for (const x of rawIds) {
      const id = String(x || '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      orderIds.push(id);
      if (orderIds.length >= MAX_BULK_ORDER_IDS) break;
    }
    if (orderIds.length === 0) {
      return jsonError(res, 400, 'ORDER_IDS_REQUIRED', `Provide orderIds (non-empty array, max ${MAX_BULK_ORDER_IDS}).`);
    }

    const parallel = parseBulkConcurrency(req.body?.concurrency);
    const results = await mapInConcurrentWindows(orderIds, parallel, (oid) => runBulkSchedulePickupSingle(oid, pickupDate));

    const succeeded = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);
    const skipped = succeeded.filter((r) => r.skipped);

    return res.json({
      success: true,
      pickupDate,
      summary: {
        total: results.length,
        succeeded: succeeded.length,
        failed: failed.length,
        skipped: skipped.length,
        completed: succeeded.filter((r) => !r.skipped).length
      },
      results
    });
  } catch (error) {
    logger.error('adminBulkFulfillmentSchedulePickup', { message: error.message, stack: error.stack });
    return jsonError(res, 500, 'BULK_SCHEDULE_PICKUP_FAILED', error.message || 'Server error');
  }
};

/** POST /orders/admin/items/:orderId/fulfillment/ensure-shipment */
exports.adminFulfillmentEnsureShipment = async (req, res) => {
  try {
    const order = await loadStaffOrder(req, res, req.params.orderId);
    if (!order) return;
    const result = await ensureShipmentForOrderExport({ order, trigger: 'admin_ensure_shipment' });
    const fresh = await Order.findOne({ orderId: order.orderId });
    const httpStatus = result.success
      ? 200
      : fulfillmentPaymentBlockHttpStatus(result.code);
    return res.status(httpStatus).json({
      success: result.success,
      code: result.code || null,
      message: result.message || null,
      details: result.details || null,
      pendingAwbAssignment: result.pendingAwbAssignment || false,
      shipment: result.shipment || null,
      order: fresh
    });
  } catch (error) {
    logger.error('adminFulfillmentEnsureShipment', { message: error.message, stack: error.stack });
    return jsonError(res, 500, 'FULFILLMENT_ENSURE_FAILED', error.message || 'Server error');
  }
};

/** POST /orders/admin/items/:orderId/fulfillment/assign-ship  body: { courierId?: number } */
exports.adminFulfillmentAssignShip = async (req, res) => {
  try {
    const order = await loadStaffOrder(req, res, req.params.orderId);
    if (!order) return;
    if (!requireFulfillmentPaymentReady(order, res)) return;
    const courierId = req.body?.courierId != null ? Number(req.body.courierId) : null;
    const assignRes = await runAssignShipFromOrder(order, courierId);
    if (!assignRes.success) {
      const c = assignRes.code || 'ASSIGN_AWB_FAILED';
      let status = 502;
      if (['SHIPMENT_ID_MISSING', 'INVALID_DELIVERY_PINCODE', 'INVALID_COURIER_ID'].includes(c)) {
        status = 400;
      } else if (c === 'AWB_ALREADY_ASSIGNED') {
        status = 409;
      } else if (c === 'ASSIGN_INTERNAL_ERROR') {
        status = 500;
      }
      return jsonError(res, status, c, assignRes.message, assignRes.details ? { details: assignRes.details } : {});
    }
    return res.json({
      success: true,
      message: assignRes.message,
      courierId: assignRes.courierId,
      shipment: assignRes.shipment,
      order: assignRes.order
    });
  } catch (error) {
    logger.error('adminFulfillmentAssignShip', { message: error.message, stack: error.stack });
    return jsonError(res, 500, 'FULFILLMENT_ASSIGN_FAILED', error.message || 'Server error');
  }
};

/** POST /orders/admin/items/:orderId/fulfillment/schedule-pickup  body: { pickupDate: "YYYY-MM-DD" } */
exports.adminFulfillmentSchedulePickup = async (req, res) => {
  try {
    const order = await loadStaffOrder(req, res, req.params.orderId);
    if (!order) return;
    if (!requireFulfillmentPaymentReady(order, res)) return;
    const shipmentId = order.shipmentInfo?.shipmentId;
    if (!shipmentId) {
      return jsonError(res, 400, 'SHIPMENT_ID_MISSING', 'No shipment_id on order.');
    }
    if (!(order.shipmentInfo?.awbCode || order.shipmentInfo?.trackingNumber)) {
      return jsonError(res, 400, 'AWB_REQUIRED', 'Assign AWB (ship) before scheduling pickup.');
    }
    const pickupDate = String(req.body?.pickupDate || '').trim();
    const dateCheck = pickupDateNotInPast(pickupDate);
    if (!dateCheck.ok) {
      return jsonError(res, 400, 'INVALID_PICKUP_DATE', dateCheck.message);
    }

    const sched = await ShiprocketService.schedulePickup({ shipmentId, pickupDate });
    if (!sched.success) {
      order.shipmentInfo = { ...(order.shipmentInfo || {}), lastPickupError: sched.message || 'pickup failed' };
      order.markModified('shipmentInfo');
      await order.save();
      return jsonError(res, 502, sched.code || 'PICKUP_FAILED', sched.message || 'Pickup schedule failed', {
        details: sched.details || null
      });
    }

    order.shipmentInfo = {
      ...(order.shipmentInfo || {}),
      pickupDate,
      pickupScheduledAt: new Date(),
      lastPickupError: null,
      providerStatus: sched.providerStatus || order.shipmentInfo?.providerStatus
    };
    order.markModified('shipmentInfo');
    await order.save();

    const fresh = await Order.findOne({ orderId: order.orderId });
    return res.json({
      success: true,
      message: 'Pickup scheduled',
      pickupDate,
      order: fresh,
      raw: sched.raw || null
    });
  } catch (error) {
    logger.error('adminFulfillmentSchedulePickup', { message: error.message, stack: error.stack });
    return jsonError(res, 500, 'FULFILLMENT_PICKUP_FAILED', error.message || 'Server error');
  }
};

/** POST /orders/admin/items/:orderId/fulfillment/shipping-label */
exports.adminFulfillmentShippingLabel = async (req, res) => {
  try {
    const order = await loadStaffOrder(req, res, req.params.orderId);
    if (!order) return;
    if (!requireFulfillmentPaymentReady(order, res)) return;
    const shipmentId = order.shipmentInfo?.shipmentId;
    if (!shipmentId) {
      return jsonError(res, 400, 'SHIPMENT_ID_MISSING', 'No shipment_id on order.');
    }
    const label = await ShiprocketService.generateShippingLabel({ shipmentId });
    if (!label.success) {
      return jsonError(res, 502, label.code || 'LABEL_FAILED', label.message || 'Label generation failed', {
        details: label.details || null
      });
    }
    await applyUpsertShipmentInfo({
      order,
      shipmentPayload: {
        labelUrl: label.labelUrl,
        providerStatus: order.shipmentInfo?.providerStatus
      },
      trigger: 'admin_shipping_label',
      allowOrderStatusUpdate: false
    });
    const fresh = await Order.findOne({ orderId: order.orderId });
    return res.json({
      success: true,
      labelUrl: label.labelUrl,
      order: fresh
    });
  } catch (error) {
    logger.error('adminFulfillmentShippingLabel', { message: error.message, stack: error.stack });
    return jsonError(res, 500, 'FULFILLMENT_LABEL_FAILED', error.message || 'Server error');
  }
};

/** POST /orders/admin/items/:orderId/fulfillment/cancel-shipment */
exports.adminFulfillmentCancelShipment = async (req, res) => {
  try {
    const order = await loadStaffOrder(req, res, req.params.orderId);
    if (!order) return;
    const srOid = order.shipmentInfo?.shiprocketOrderId;
    if (!srOid) {
      return jsonError(res, 400, 'SHIPROCKET_ORDER_ID_MISSING', 'No Shiprocket order id stored; cannot cancel remotely.');
    }
    if (order.shipmentInfo?.pickupScheduledAt || order.shipmentInfo?.pickupDate) {
      return jsonError(res, 409, 'PICKUP_ALREADY_SCHEDULED', 'Pickup already scheduled; cancellation may need Shiprocket support.');
    }
    if (order.orderStatus === 'shipped' || order.orderStatus === 'out_for_delivery' || order.orderStatus === 'delivered') {
      return jsonError(res, 409, 'ORDER_TOO_FAR', 'Cannot cancel shipment at this order stage.');
    }

    const cancel = await ShiprocketService.cancelShiprocketOrders([srOid]);
    if (!cancel.success) {
      return jsonError(res, 502, cancel.code || 'CANCEL_FAILED', cancel.message || 'Shiprocket cancel failed', {
        details: cancel.details || null
      });
    }

    order.shipmentInfo = {
      ...(order.shipmentInfo || {}),
      lastSyncAt: new Date(),
      lastSyncSource: 'admin_cancel_shipment',
      providerStatus: 'cancel_requested',
      lastError: null
    };
    order.markModified('shipmentInfo');
    await order.save();

    return res.json({ success: true, message: 'Shiprocket cancel request submitted', raw: cancel.raw || null });
  } catch (error) {
    logger.error('adminFulfillmentCancelShipment', { message: error.message, stack: error.stack });
    return jsonError(res, 500, 'FULFILLMENT_CANCEL_FAILED', error.message || 'Server error');
  }
};

/** GET /orders/admin/items/:orderId/fulfillment/couriers — serviceability list for manual choice */
exports.adminFulfillmentListCouriers = async (req, res) => {
  try {
    const order = await loadStaffOrder(req, res, req.params.orderId);
    if (!order) return;
    if (!requireFulfillmentPaymentReady(order, res)) return;
    const parts = await ShiprocketService.buildAdhocPayloadParts(order);
    const deliveryPin = String(parts.addr?.postalCode || '').replace(/\D/g, '').slice(0, 6);
    if (deliveryPin.length !== 6) {
      return jsonError(res, 400, 'INVALID_DELIVERY_PINCODE', 'Order address must include a 6-digit delivery pincode.');
    }
    const listRes = await ShiprocketService.listCouriersForRoute(deliveryPin, {
      weightKg: parts.totalWeight,
      lengthCm: parts.maxL,
      widthCm: parts.maxB,
      heightCm: parts.maxH,
      codAmount: parts.codAmountForQuote
    });
    if (!listRes.success) {
      return jsonError(res, 502, 'COURIER_LIST_FAILED', listRes.message || 'Could not list couriers');
    }
    return res.json({
      success: true,
      recommendedCourierId: ShiprocketService.pickRecommendedCourierId(listRes.couriers || [], {
        codRequired: parts.useCodAtDoor
      }),
      couriers: listRes.couriers || [],
      mock: listRes.mock || false
    });
  } catch (error) {
    logger.error('adminFulfillmentListCouriers', { message: error.message, stack: error.stack });
    return jsonError(res, 500, 'FULFILLMENT_COURIERS_FAILED', error.message || 'Server error');
  }
};

/** GET /orders/admin/items/:orderId/invoice-html */
exports.adminInvoiceHtml = async (req, res) => {
  try {
    const order = await loadStaffOrder(req, res, req.params.orderId);
    if (!order) return;
    const vm = buildGstInvoiceViewModel(order);
    const html = buildGstInvoiceHtml(vm);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  } catch (error) {
    logger.error('adminInvoiceHtml', { message: error.message, stack: error.stack });
    return jsonError(res, 500, 'INVOICE_HTML_FAILED', error.message || 'Server error');
  }
};

/** POST /orders/admin/returns/requests/:orderId/reverse-pickup/retry */
exports.adminReturnReversePickupRetry = async (req, res) => {
  try {
    const order = await loadStaffOrder(req, res, req.params.orderId);
    if (!order) return;
    const st = String(order.returnInfo?.status || '').toLowerCase();
    const hasReverse = Boolean(order.returnInfo?.reverseAwbCode || order.returnInfo?.reverseTrackingNumber);
    const canRetry = st === 'approval_failed' || (st === 'approved' && !hasReverse);
    if (!canRetry) {
      return jsonError(
        res,
        409,
        'RETURN_RETRY_NOT_ALLOWED',
        'Reverse pickup retry is only allowed after a failed Shiprocket pickup create, or an approved return without reverse AWB yet.'
      );
    }
    const reverse = await ShiprocketService.createReturnPickup(order, order.returnInfo || {});
    if (!reverse?.success) {
      order.returnInfo = {
        ...(order.returnInfo || {}),
        reverseLastError: String(reverse?.error || 'Could not initiate reverse pickup')
      };
      order.markModified('returnInfo');
      await order.save();
      return jsonError(res, 502, 'REVERSE_PICKUP_CREATE_FAILED', 'Reverse pickup initiation failed', {
        details: reverse?.error || null
      });
    }
    order.returnInfo = {
      ...(order.returnInfo || {}),
      status: 'approved',
      reverseShipmentId: reverse.reverseShipmentId || order.returnInfo?.reverseShipmentId || null,
      reverseAwbCode: reverse.reverseAwbCode || order.returnInfo?.reverseAwbCode || null,
      reverseTrackingNumber: reverse.reverseTrackingNumber || order.returnInfo?.reverseTrackingNumber || null,
      reverseCourier: reverse.reverseCourier || order.returnInfo?.reverseCourier || null,
      reverseProviderStatus: reverse.providerStatus || 'reverse_pickup_created',
      reverseLastSyncAt: new Date(),
      reverseLastError: null
    };
    order.markModified('returnInfo');
    await order.save();
    return res.json({ success: true, message: 'Reverse pickup re-initiated', orderId: order.orderId });
  } catch (error) {
    logger.error('adminReturnReversePickupRetry', { message: error.message, stack: error.stack });
    return jsonError(res, 500, 'RETURN_RETRY_FAILED', error.message || 'Server error');
  }
};
