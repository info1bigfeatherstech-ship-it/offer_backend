/**
 * Admin-only Shiprocket fulfillment: ensure create, assign AWB (ship), scheduled pickup, label, cancel.
 * Uses shared shipment sync from order.controller.
 */

const axios = require('axios');
const AdmZip = require('adm-zip');
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
const {
  runAdminApproveOrderSingle,
  runAdminCancelOrderSingle
} = require('../services/adminOrderApproval.service');

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
  const order = await Order.findOne({ orderId: id }).populate('items.productId', 'name slug shipping variants');
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
const FULFILLMENT_ITEM_POPULATE = { path: 'items.productId', select: 'name slug shipping variants' };

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

/** Dedupe and cap bulk `orderIds` from JSON body (max MAX_BULK_ORDER_IDS). */
function normalizeBulkOrderIds(body) {
  const rawIds = Array.isArray(body?.orderIds) ? body.orderIds : [];
  const seen = new Set();
  const orderIds = [];
  for (const x of rawIds) {
    const id = String(x || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    orderIds.push(id);
    if (orderIds.length >= MAX_BULK_ORDER_IDS) break;
  }
  return orderIds;
}

/**
 * Fetch Shiprocket label PDF bytes (same rules as single-label download).
 * @param {import('mongoose').Document} order — populated staff order
 * @returns {Promise<Buffer>}
 */
async function fetchShiprocketLabelPdfBuffer(order) {
  const shipmentId = order.shipmentInfo?.shipmentId;
  if (!shipmentId) {
    const e = new Error('No shipment_id on order.');
    e.code = 'SHIPMENT_ID_MISSING';
    throw e;
  }
  const gate = evaluateOrderPaymentForShiprocketFulfillment(order);
  if (!gate.ok) {
    const e = new Error(gate.message || 'Payment rules do not allow this shipment action.');
    e.code = gate.code || 'PAYMENT_REQUIRED';
    e.details = gate.details || null;
    throw e;
  }
  const siPre = order.shipmentInfo || {};
  const hasAwb = Boolean(siPre.awbCode || siPre.trackingNumber);
  if (!hasAwb) {
    const e = new Error('Assign AWB before downloading or opening a shipping label.');
    e.code = 'AWB_REQUIRED';
    throw e;
  }
  let labelUrl = order.shipmentInfo?.labelUrl ? String(order.shipmentInfo.labelUrl).trim() : '';
  if (!labelUrl) {
    const label = await ShiprocketService.generateShippingLabel({ shipmentId });
    if (!label.success || !label.labelUrl) {
      const e = new Error(label.message || 'Could not get shipping label URL');
      e.code = label.code || 'LABEL_FAILED';
      throw e;
    }
    await applyUpsertShipmentInfo({
      order,
      shipmentPayload: {
        labelUrl: label.labelUrl,
        providerStatus: order.shipmentInfo?.providerStatus
      },
      trigger: 'admin_shipping_label_pdf',
      allowOrderStatusUpdate: false
    });
    labelUrl = String(label.labelUrl).trim();
  }
  const external = await axios.get(labelUrl, {
    responseType: 'arraybuffer',
    timeout: 45000,
    maxContentLength: 25 * 1024 * 1024,
    headers: {
      Accept: 'application/pdf,application/octet-stream,*/*',
      'User-Agent': 'Mozilla/5.0 (compatible; OfferWaleBaba/1.0; +https://offerwalebaba.com)'
    },
    validateStatus: (s) => s >= 200 && s < 400
  });
  const buf = Buffer.from(external.data || []);
  if (!buf.length) {
    const e = new Error('Label download returned empty body');
    e.code = 'LABEL_EMPTY_BODY';
    throw e;
  }
  return buf;
}

function safeZipEntryBase(orderId, suffix) {
  return `${String(orderId).replace(/[^\w.-]+/g, '_').slice(0, 80)}${suffix}`;
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
    let shipmentId = order.shipmentInfo?.shipmentId ? String(order.shipmentInfo.shipmentId).trim() : '';
    if (!shipmentId && order.shipmentInfo?.shiprocketOrderId) {
      const lookup = await ShiprocketService.fetchShipmentIdForForwardOrder({
        shiprocketOrderId: order.shipmentInfo.shiprocketOrderId,
        channelOrderId: order.orderId
      });
      if (lookup.success && lookup.shipmentId) {
        shipmentId = String(lookup.shipmentId).trim();
        await applyUpsertShipmentInfo({
          order,
          shipmentPayload: { shipmentId: lookup.shipmentId },
          trigger: 'admin_resolve_shipment_id',
          allowOrderStatusUpdate: false
        });
      }
    }
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

    // Ship Now uses checkout-quoted courier (shippingSnapshot) unless staff passes courierId.
    let courierId = courierIdOverride != null ? Number(courierIdOverride) : null;
    if (courierId != null && !Number.isFinite(courierId)) {
      return { success: false, code: 'INVALID_COURIER_ID', message: 'courierId must be a number when provided.' };
    }

    const quotedCourierId =
      order.shippingSnapshot?.courierCompanyId != null &&
      Number.isFinite(Number(order.shippingSnapshot.courierCompanyId)) &&
      Number(order.shippingSnapshot.courierCompanyId) > 0
        ? Number(order.shippingSnapshot.courierCompanyId)
        : null;
    const quotedCourierName = String(order.shippingSnapshot?.courierName || '').trim() || null;

    if (courierId == null) {
      if (quotedCourierId != null) {
        courierId = quotedCourierId;
      } else if (!ShiprocketService.enabled) {
        // Mock/dev tariff — no Shiprocket company id on snapshot.
        courierId = 1;
      } else {
        return {
          success: false,
          code: 'QUOTED_COURIER_ID_MISSING',
          message:
            'This order has no checkout courier id (shippingSnapshot.courierCompanyId). ' +
            'Ship Now only assigns the courier the customer paid shipping for — fix the order snapshot or re-checkout.'
        };
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

    const effectiveAwb =
      Boolean(assign.mock) ||
      Boolean(String(assign.awbCode || '').trim()) ||
      Boolean(String(assign.trackingNumber || '').trim()) ||
      Number(assign.raw?.awb_assign_status) === 1;
    if (!effectiveAwb) {
      const raw = assign.raw || {};
      const nested = raw.response?.data && typeof raw.response.data === 'object' ? raw.response.data : {};
      const walletMsg =
        nested.awb_assign_error ||
        raw.message ||
        assign.message ||
        'Shiprocket did not issue an AWB. Recharge the Shiprocket wallet or try another courier.';
      return {
        success: false,
        code: 'ASSIGN_AWB_NOT_COMPLETED',
        message: walletMsg,
        details: raw,
        shipment: assign
      };
    }

    await applyUpsertShipmentInfo({
      order,
      shipmentPayload: {
        ...assign,
        courier: assign.courier || quotedCourierName,
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
    const orderIds = normalizeBulkOrderIds(req.body);
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

    const orderIds = normalizeBulkOrderIds(req.body);
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
      } else if (c === 'SHIPROCKET_WALLET_OR_BALANCE') {
        status = 402;
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
    const hasAwb = Boolean(order.shipmentInfo?.awbCode || order.shipmentInfo?.trackingNumber);
    if (!hasAwb) {
      return jsonError(res, 400, 'AWB_REQUIRED', 'Assign AWB before requesting a shipping label from Shiprocket.');
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

/**
 * GET /orders/admin/items/:orderId/fulfillment/shipping-label-file
 * Proxies Shiprocket label PDF so the admin can download without CORS issues.
 */
exports.adminFulfillmentShippingLabelFile = async (req, res) => {
  try {
    const order = await loadStaffOrder(req, res, req.params.orderId);
    if (!order) return;
    if (!requireFulfillmentPaymentReady(order, res)) return;

    let buf;
    try {
      buf = await fetchShiprocketLabelPdfBuffer(order);
    } catch (fetchErr) {
      logger.error('adminFulfillmentShippingLabelFile fetch', {
        message: fetchErr.message,
        stack: fetchErr.stack,
        code: fetchErr.code,
        status: fetchErr.response?.status
      });
      const code = fetchErr.code || 'LABEL_FILE_FAILED';
      if (code === 'SHIPMENT_ID_MISSING') {
        return jsonError(res, 400, code, fetchErr.message || 'No shipment_id on order.');
      }
      if (code === 'AWB_REQUIRED') {
        return jsonError(res, 400, code, fetchErr.message || 'Assign AWB first.');
      }
      const payHttp = fulfillmentPaymentBlockHttpStatus(code);
      if (payHttp === 403) {
        return jsonError(res, 403, code, fetchErr.message || 'Payment rules block this action.', {
          details: fetchErr.details != null ? fetchErr.details : null
        });
      }
      if (fetchErr.response?.status) {
        return jsonError(
          res,
          502,
          'LABEL_FILE_FETCH_FAILED',
          `Could not download label from Shiprocket URL (HTTP ${fetchErr.response.status}).`
        );
      }
      if (code === 'LABEL_FAILED' || code === 'LABEL_EMPTY_BODY') {
        return jsonError(res, 502, code, fetchErr.message || 'Label error', {
          details: fetchErr.details || null
        });
      }
      return jsonError(res, 500, code, fetchErr.message || 'Server error');
    }

    const safe = String(order.orderId || 'order').replace(/[^\w.-]+/g, '_').slice(0, 80);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Shiprocket-label-${safe}.pdf"`);
    return res.status(200).send(buf);
  } catch (error) {
    logger.error('adminFulfillmentShippingLabelFile', {
      message: error.message,
      stack: error.stack,
      status: error.response?.status
    });
    return jsonError(res, 500, 'LABEL_FILE_FAILED', error.message || 'Server error');
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

const BULK_DOC_SKIP_STATUSES = new Set(['cancelled', 'payment_failed']);

/** POST /orders/admin/items/bulk-documents/tax-invoices-zip — ZIP of GST invoice HTML + manifest.json */
exports.adminBulkTaxInvoicesZip = async (req, res) => {
  try {
    if (!assertStaffJson(req, res)) return;
    const orderIds = normalizeBulkOrderIds(req.body);
    if (orderIds.length === 0) {
      return jsonError(res, 400, 'ORDER_IDS_REQUIRED', `Provide orderIds (non-empty array, max ${MAX_BULK_ORDER_IDS}).`);
    }
    const parallel = parseBulkConcurrency(req.body?.concurrency);

    const results = await mapInConcurrentWindows(orderIds, parallel, async (oid) => {
      try {
        const order = await loadOrderDocByOrderId(oid);
        if (!order) {
          return { orderId: oid, success: false, code: 'ORDER_NOT_FOUND', message: 'Order not found' };
        }
        const st = String(order.orderStatus || '').toLowerCase();
        if (BULK_DOC_SKIP_STATUSES.has(st)) {
          return {
            orderId: oid,
            success: false,
            code: 'SKIP_BAD_STATUS',
            message: `Cannot build invoice for status ${order.orderStatus}`
          };
        }
        const vm = buildGstInvoiceViewModel(order);
        const html = buildGstInvoiceHtml(vm);
        const entryName = safeZipEntryBase(oid, '-tax-invoice.html');
        return { orderId: oid, success: true, entryName, html };
      } catch (err) {
        logger.error('adminBulkTaxInvoicesZip row', { orderId: oid, message: err?.message, stack: err?.stack });
        return {
          orderId: oid,
          success: false,
          code: 'INVOICE_BUILD_FAILED',
          message: err?.message || String(err)
        };
      }
    });

    const succeeded = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);
    if (succeeded.length === 0) {
      return jsonError(res, 400, 'BULK_INVOICES_NONE', 'No tax invoices could be added to the ZIP.', {
        failed: failed.map((r) => ({ orderId: r.orderId, code: r.code, message: r.message }))
      });
    }

    const zip = new AdmZip();
    const manifest = {
      type: 'tax_invoices',
      generatedAt: new Date().toISOString(),
      summary: {
        total: results.length,
        succeeded: succeeded.length,
        failed: failed.length
      },
      succeeded: succeeded.map((r) => ({ orderId: r.orderId, file: r.entryName })),
      failed: failed.map((r) => ({ orderId: r.orderId, code: r.code, message: r.message }))
    };
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
    for (const row of succeeded) {
      zip.addFile(row.entryName, Buffer.from(row.html, 'utf8'));
    }
    const buf = zip.toBuffer();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="tax-invoices-bulk-${Date.now()}.zip"`);
    return res.status(200).send(buf);
  } catch (error) {
    logger.error('adminBulkTaxInvoicesZip', { message: error.message, stack: error.stack });
    return jsonError(res, 500, 'BULK_INVOICES_ZIP_FAILED', error.message || 'Server error');
  }
};

/** POST /orders/admin/items/bulk-documents/shipping-labels-zip — ZIP of label PDFs + manifest.json */
exports.adminBulkShippingLabelsZip = async (req, res) => {
  try {
    if (!assertStaffJson(req, res)) return;
    const orderIds = normalizeBulkOrderIds(req.body);
    if (orderIds.length === 0) {
      return jsonError(res, 400, 'ORDER_IDS_REQUIRED', `Provide orderIds (non-empty array, max ${MAX_BULK_ORDER_IDS}).`);
    }
    const parallel = parseBulkConcurrency(req.body?.concurrency);

    const results = await mapInConcurrentWindows(orderIds, parallel, async (oid) => {
      try {
        const order = await loadOrderDocByOrderId(oid);
        if (!order) {
          return { orderId: oid, success: false, code: 'ORDER_NOT_FOUND', message: 'Order not found' };
        }
        const st = String(order.orderStatus || '').toLowerCase();
        if (BULK_DOC_SKIP_STATUSES.has(st)) {
          return {
            orderId: oid,
            success: false,
            code: 'SKIP_BAD_STATUS',
            message: `Cannot download label for status ${order.orderStatus}`
          };
        }
        const pdfBuf = await fetchShiprocketLabelPdfBuffer(order);
        const entryName = safeZipEntryBase(oid, '-shipping-label.pdf');
        return { orderId: oid, success: true, entryName, pdfBuf };
      } catch (err) {
        const code = err.code || 'LABEL_FAILED';
        logger.error('adminBulkShippingLabelsZip row', {
          orderId: oid,
          code,
          message: err?.message,
          httpStatus: err.response?.status
        });
        return { orderId: oid, success: false, code, message: err?.message || String(err) };
      }
    });

    const succeeded = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);
    if (succeeded.length === 0) {
      return jsonError(res, 400, 'BULK_LABELS_NONE', 'No shipping labels could be added to the ZIP.', {
        failed: failed.map((r) => ({ orderId: r.orderId, code: r.code, message: r.message }))
      });
    }

    const zip = new AdmZip();
    const manifest = {
      type: 'shipping_labels',
      generatedAt: new Date().toISOString(),
      summary: {
        total: results.length,
        succeeded: succeeded.length,
        failed: failed.length
      },
      succeeded: succeeded.map((r) => ({ orderId: r.orderId, file: r.entryName })),
      failed: failed.map((r) => ({ orderId: r.orderId, code: r.code, message: r.message }))
    };
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
    for (const row of succeeded) {
      zip.addFile(row.entryName, row.pdfBuf);
    }
    const buf = zip.toBuffer();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="shipping-labels-bulk-${Date.now()}.zip"`);
    return res.status(200).send(buf);
  } catch (error) {
    logger.error('adminBulkShippingLabelsZip', { message: error.message, stack: error.stack });
    return jsonError(res, 500, 'BULK_LABELS_ZIP_FAILED', error.message || 'Server error');
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

/** POST /orders/admin/items/bulk-approval/confirm  body: { orderIds: string[], concurrency?: number } */
exports.adminBulkApprovalConfirm = async (req, res) => {
  try {
    if (!assertStaffJson(req, res)) return;
    const orderIds = normalizeBulkOrderIds(req.body);
    if (orderIds.length === 0) {
      return jsonError(res, 400, 'ORDER_IDS_REQUIRED', `Provide orderIds (non-empty array, max ${MAX_BULK_ORDER_IDS}).`);
    }

    const parallel = parseBulkConcurrency(req.body?.concurrency);
    const results = await mapInConcurrentWindows(orderIds, parallel, (oid) => runAdminApproveOrderSingle(oid));

    const succeeded = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);
    const skipped = succeeded.filter((r) => r.skipped);
    const shipmentDeferred = succeeded.filter((r) => r.code === 'CONFIRMED_SHIPMENT_DEFERRED');

    return res.json({
      success: true,
      summary: {
        total: results.length,
        succeeded: succeeded.length,
        failed: failed.length,
        skipped: skipped.length,
        completed: succeeded.filter((r) => !r.skipped).length,
        shipmentDeferred: shipmentDeferred.length
      },
      results
    });
  } catch (error) {
    logger.error('adminBulkApprovalConfirm', { message: error.message, stack: error.stack });
    return jsonError(res, 500, 'BULK_CONFIRM_FAILED', error.message || 'Server error');
  }
};

/** POST /orders/admin/items/bulk-approval/cancel  body: { orderIds: string[], concurrency?: number } */
exports.adminBulkApprovalCancel = async (req, res) => {
  try {
    if (!assertStaffJson(req, res)) return;
    const orderIds = normalizeBulkOrderIds(req.body);
    if (orderIds.length === 0) {
      return jsonError(res, 400, 'ORDER_IDS_REQUIRED', `Provide orderIds (non-empty array, max ${MAX_BULK_ORDER_IDS}).`);
    }

    const parallel = parseBulkConcurrency(req.body?.concurrency);
    const results = await mapInConcurrentWindows(orderIds, parallel, (oid) => runAdminCancelOrderSingle(oid));

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
    logger.error('adminBulkApprovalCancel', { message: error.message, stack: error.stack });
    return jsonError(res, 500, 'BULK_CANCEL_FAILED', error.message || 'Server error');
  }
};
