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
const {
  buildShipmentOpsView,
  evaluateAndPersistShipmentOps,
  assertShipmentOpsAction
} = require('../services/shipmentOps');
const {
  reconcileOrderFromShiprocket,
  applyLocalShipmentReset,
  detectForwardOrderReset
} = require('../services/shiprocketReconcile.service');
const {
  isCourierInactive,
  pickCheapestActiveCourier,
  filterActiveCouriers,
  buildCourierSubstituteNote
} = require('../services/courierPolicy.service');

function jsonError(res, status, code, message, extras = {}) {
  return res.status(status).json({ success: false, code, message, ...extras });
}

function requireShipmentOpsAction(order, actionKey, res) {
  const check = assertShipmentOpsAction(order, actionKey);
  if (check.ok) return check.view;
  jsonError(res, 409, check.code || 'SHIPMENT_OPS_ACTION_BLOCKED', check.message, {
    opsState: check.opsState || null,
    blockReasons: check.blockReasons || null
  });
  return null;
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
 * Build shipment payload from Shiprocket orders/show snapshot.
 * @param {ReturnType<typeof ShiprocketService.extractForwardOrderSnapshot>} snapshot
 */
function isOrderPickupBookedOnShiprocket(shipmentInfo) {
  const si = shipmentInfo || {};
  if (si.pickupDate || si.pickupScheduledAt) return true;
  if (ShiprocketService.isPickupAlreadyScheduledMessage(si.lastPickupError)) return true;
  if (ShiprocketService.isPickupAlreadyScheduledMessage(si.providerStatus)) return true;
  return false;
}

function shipmentPayloadFromForwardSnapshot(snapshot) {
  if (!snapshot) return {};
  const payload = {};
  if (snapshot.shipmentId) payload.shipmentId = snapshot.shipmentId;
  if (snapshot.shiprocketOrderId) payload.shiprocketOrderId = snapshot.shiprocketOrderId;
  if (snapshot.awbCode) payload.awbCode = snapshot.awbCode;
  if (snapshot.trackingNumber) payload.trackingNumber = snapshot.trackingNumber;
  if (snapshot.courier) payload.courier = snapshot.courier;
  if (snapshot.labelUrl) payload.labelUrl = snapshot.labelUrl;
  if (snapshot.manifestUrl) payload.manifestUrl = snapshot.manifestUrl;
  if (snapshot.providerStatus) payload.providerStatus = snapshot.providerStatus;
  return payload;
}

/**
 * After remote cancel, sync Shiprocket and clear stale forward-shipment fields so Ship now can run again.
 * @param {import('mongoose').Document} order
 */
async function finalizeShipmentAfterRemoteCancel(order) {
  const synced = await syncShipmentFromShiprocket(order, 'admin_cancel_shipment_sync');
  let fresh = synced.success ? await Order.findOne({ orderId: order.orderId }) : null;
  if (!fresh) return null;

  if (!synced.resetApplied) {
    const si = fresh.shipmentInfo || {};
    const providerStatus = String(si.providerStatus || '').toLowerCase();
    const resetLike =
      /cancel|auto cancel|pickupcancel|new|reset|pickup exception|pickup error/.test(providerStatus) ||
      !(si.awbCode || si.trackingNumber);

    if (resetLike) {
      fresh = await applyLocalShipmentReset(fresh, {
        reason: si.providerStatus || 'cancelled_on_shiprocket',
        trigger: 'admin_cancel_shipment_clear',
        appendEvent: false
      });
    }
  }

  if (fresh) {
    await evaluateAndPersistShipmentOps(fresh, { source: 'admin_cancel_shipment' });
  }
  return fresh;
}

/**
 * Persist courier pickup day from Shiprocket only (never admin-selected dates).
 */
async function persistPickupDateFromShiprocket(order, snap, trigger) {
  const freshOrder = await Order.findOne({ orderId: order.orderId });
  if (!freshOrder) return { success: false, pickupDate: null, source: 'none' };

  const shipmentId = freshOrder.shipmentInfo?.shipmentId || snap?.shipmentId;

  const resolved = await ShiprocketService.resolveAuthoritativePickupDate({
    shipmentId,
    shiprocketOrderId: freshOrder.shipmentInfo?.shiprocketOrderId || snap?.shiprocketOrderId,
    channelOrderId: freshOrder.orderId
  });

  const payload = {};
  if (
    resolved.success &&
    resolved.pickupDate &&
    ShiprocketService.isPlausibleCourierPickupYmd(resolved.pickupDate)
  ) {
    payload.pickupDate = resolved.pickupDate;
  } else if (
    freshOrder.shipmentInfo?.pickupDate &&
    !ShiprocketService.isPlausibleCourierPickupYmd(freshOrder.shipmentInfo.pickupDate)
  ) {
    payload.pickupDate = null;
  }

  if (snap?.pickupScheduled || resolved.success) {
    if (!order.shipmentInfo?.pickupScheduledAt) {
      payload.pickupScheduledAt = new Date();
    }
    payload.lastPickupError = null;
  }

  if (Object.keys(payload).length === 0) return resolved;

  if (Object.keys(payload).length > 0) {
    await applyUpsertShipmentInfo({
      order: freshOrder,
      shipmentPayload: payload,
      trigger: trigger || 'admin_pickup_date_resolve',
      allowOrderStatusUpdate: false
    });
  }
  return resolved;
}

/**
 * Pull authoritative state from Shiprocket via unified reconcile.
 * @param {import('mongoose').Document} order
 * @param {string} trigger
 */
async function syncShipmentFromShiprocket(order, trigger) {
  const result = await reconcileOrderFromShiprocket(order, {
    source: trigger || 'admin_shiprocket_sync',
    mode: 'full',
    allowOrderStatusUpdate: true
  });
  if (!result.success) {
    return {
      success: false,
      code: result.code || 'SYNC_FAILED',
      message: result.message || 'Sync failed'
    };
  }

  return {
    success: true,
    snapshot: result.snapshot || null,
    pickupDate: result.pickupDate || null,
    pickupDateSource: result.snapshot?.pickupDate ? 'reconcile' : null,
    resetApplied: result.resetApplied || false
  };
}

/** Clear queue errors and backfill pickup booked timestamp when Shiprocket already has pickup/manifest. */
async function repairPickupStateAfterShiprocketSync(order, snap) {
  let fresh = await Order.findOne({ orderId: order.orderId });
  if (!fresh) return null;

  const si = fresh.shipmentInfo || {};
  const resetCheck = detectForwardOrderReset({
    statusCode: snap?.statusCode,
    statusLabel: si.providerStatus,
    statusMessage: snap?.statusMessage,
    texts: snap?.signalTexts,
    awbCode: si.awbCode,
    hadLocalAwb: Boolean(si.awbCode || si.trackingNumber)
  });
  if (snap?.resetDetected || resetCheck.resetDetected) {
    return fresh;
  }

  await persistPickupDateFromShiprocket(order, snap, 'admin_pickup_state_repair');

  fresh = await Order.findOne({ orderId: order.orderId });
  if (!fresh) return null;
  const si2 = fresh.shipmentInfo || {};
  const queueErr = ShiprocketService.isPickupAlreadyScheduledMessage(si2.lastPickupError);
  const manifestDone = Boolean(si2.manifestUrl);
  const needsBookedAt =
    (queueErr || manifestDone || isOrderPickupBookedOnShiprocket(si2)) && !si2.pickupScheduledAt;
  const needsErrorClear = queueErr;

  if (!needsBookedAt && !needsErrorClear) return fresh;

  const payload = {};
  if (needsErrorClear) payload.lastPickupError = null;
  if (needsBookedAt) payload.pickupScheduledAt = new Date();
  if (manifestDone && !si2.providerStatus) {
    payload.providerStatus = 'pickup_scheduled';
  }

  await applyUpsertShipmentInfo({
    order: fresh,
    shipmentPayload: payload,
    trigger: 'admin_pickup_state_repair',
    allowOrderStatusUpdate: false
  });
  return Order.findOne({ orderId: order.orderId });
}

/**
 * Resolve Shiprocket numeric order id; optionally backfill from orders/show.
 * @param {import('mongoose').Document} order
 */
async function resolveShiprocketOrderIdForOrder(order) {
  const existing = order.shipmentInfo?.shiprocketOrderId
    ? String(order.shipmentInfo.shiprocketOrderId).trim()
    : '';
  if (existing) return existing;

  const synced = await syncShipmentFromShiprocket(order, 'admin_resolve_shiprocket_order_id');
  if (synced.success && synced.snapshot?.shiprocketOrderId) {
    return String(synced.snapshot.shiprocketOrderId).trim();
  }
  return '';
}

/**
 * Shared pickup scheduling outcome — persists SR-confirmed dates and syncs on conflicts.
 * @returns {Promise<{ success: boolean, skipped?: boolean, code?: string|null, message: string, pickupDate?: string, alreadyScheduled?: boolean }>}
 */
async function applyPickupScheduleOutcome(order, { sched, requestedPickupDate, trigger }) {
  const requested = String(requestedPickupDate || '').trim();

  if (sched.success) {
    let confirmedDate =
      ShiprocketService.parsePickupDateFromScheduleResponse(sched.raw, null) || sched.pickupDate || null;
    const synced = await syncShipmentFromShiprocket(order, `${trigger || 'admin_schedule_pickup'}_sync`);
    if (!confirmedDate && synced.pickupDate) confirmedDate = synced.pickupDate;
    if (!confirmedDate) {
      const auth = await ShiprocketService.resolveAuthoritativePickupDate({
        shipmentId: order.shipmentInfo?.shipmentId,
        shiprocketOrderId: order.shipmentInfo?.shiprocketOrderId,
        channelOrderId: order.orderId
      });
      if (auth.success && auth.pickupDate) confirmedDate = auth.pickupDate;
    }
    const dateAdjusted = Boolean(requested && confirmedDate && confirmedDate !== requested);
    if (confirmedDate) {
      await applyUpsertShipmentInfo({
        order,
        shipmentPayload: {
          pickupDate: confirmedDate,
          pickupScheduledAt: new Date(),
          lastPickupError: null,
          providerStatus: sched.providerStatus || order.shipmentInfo?.providerStatus
        },
        trigger: trigger || 'admin_schedule_pickup',
        allowOrderStatusUpdate: false
      });
    } else {
      await applyUpsertShipmentInfo({
        order,
        shipmentPayload: {
          pickupScheduledAt: new Date(),
          lastPickupError: null,
          providerStatus: sched.providerStatus || order.shipmentInfo?.providerStatus
        },
        trigger: trigger || 'admin_schedule_pickup',
        allowOrderStatusUpdate: false
      });
    }
    const message = !confirmedDate
      ? 'Pickup scheduled on Shiprocket. Refresh sync to load the courier pickup day.'
      : dateAdjusted
        ? `Pickup scheduled. You selected ${requested}; Shiprocket confirmed ${confirmedDate}.`
        : `Pickup scheduled for ${confirmedDate}.`;
    return {
      success: true,
      skipped: false,
      code: null,
      message,
      pickupDate: confirmedDate,
      requestedPickupDate: requested,
      dateAdjusted
    };
  }

  const schedMsg =
    sched.message ||
    (sched.details && typeof sched.details === 'object'
      ? sched.details.message || sched.details.error || sched.details.payload
      : null);
  if (ShiprocketService.isPickupAlreadyScheduledMessage(schedMsg)) {
    const synced = await syncShipmentFromShiprocket(order, `${trigger || 'admin_schedule_pickup'}_already`);
    const fresh = await Order.findOne({ orderId: order.orderId });
    const savedDate = synced.pickupDate || fresh?.shipmentInfo?.pickupDate || null;
    return {
      success: true,
      skipped: true,
      alreadyScheduled: true,
      code: 'PICKUP_ALREADY_ON_SHIPROCKET',
      message: savedDate
        ? `Pickup is already scheduled on Shiprocket (${savedDate}).`
        : 'Pickup is already scheduled on Shiprocket. Use Refresh from Shiprocket to load the courier pickup day.',
      pickupDate: savedDate
    };
  }

  order.shipmentInfo = {
    ...(order.shipmentInfo || {}),
    lastPickupError: sched.message || 'Pickup schedule failed'
  };
  order.markModified('shipmentInfo');
  await order.save();

  return {
    success: false,
    skipped: false,
    code: sched.code || 'PICKUP_FAILED',
    message: sched.message || 'Pickup schedule failed',
    details: sched.details || null
  };
}

/**
 * Fetch Shiprocket label PDF bytes (same rules as single-label download).
 * @param {import('mongoose').Document} order — populated staff order
 * @returns {Promise<Buffer>}
 */
async function fetchShiprocketLabelPdfBuffer(order) {
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

  const shiprocketOrderId = await resolveShiprocketOrderIdForOrder(order);
  if (!shiprocketOrderId) {
    const e = new Error(
      'No Shiprocket order id on this order. Use Ship now to create the forward order on Shiprocket first.'
    );
    e.code = 'SHIPROCKET_ORDER_ID_MISSING';
    throw e;
  }

  const cachedUrl = order.shipmentInfo?.labelUrl ? String(order.shipmentInfo.labelUrl).trim() : '';
  let labelUrl =
    cachedUrl && !ShiprocketService.isLikelyTaxInvoiceUrl(cachedUrl) ? cachedUrl : '';

  if (!labelUrl) {
    const label = await ShiprocketService.generateShippingLabel({
      shiprocketOrderId,
      channelOrderId: order.orderId,
      shipmentId: order.shipmentInfo?.shipmentId
    });
    if (!label.success || !label.labelUrl) {
      const e = new Error(label.message || 'Could not get shipping label URL');
      e.code = label.code || 'LABEL_FAILED';
      e.details = label.details || null;
      throw e;
    }
    await applyUpsertShipmentInfo({
      order,
      shipmentPayload: {
        labelUrl: label.labelUrl,
        shiprocketOrderId: label.shiprocketOrderId || shiprocketOrderId,
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

/**
 * Fetch Shiprocket manifest PDF bytes (generate + print flow).
 * @param {import('mongoose').Document} order
 * @returns {Promise<Buffer>}
 */
async function fetchShiprocketManifestPdfBuffer(order) {
  const gate = evaluateOrderPaymentForShiprocketFulfillment(order);
  if (!gate.ok) {
    const e = new Error(gate.message || 'Payment rules do not allow this shipment action.');
    e.code = gate.code || 'PAYMENT_REQUIRED';
    throw e;
  }
  const hasAwb = Boolean(order.shipmentInfo?.awbCode || order.shipmentInfo?.trackingNumber);
  if (!hasAwb) {
    const e = new Error('Assign AWB before downloading a manifest.');
    e.code = 'AWB_REQUIRED';
    throw e;
  }
  const shipmentId = order.shipmentInfo?.shipmentId;
  if (!shipmentId) {
    const e = new Error('No shipment_id on order.');
    e.code = 'SHIPMENT_ID_MISSING';
    throw e;
  }

  let manifestUrl = order.shipmentInfo?.manifestUrl ? String(order.shipmentInfo.manifestUrl).trim() : '';
  if (!manifestUrl) {
    const generated = await ShiprocketService.generateManifest({ shipmentId });
    if (!generated.success) {
      const e = new Error(generated.message || 'Manifest generation failed');
      e.code = generated.code || 'MANIFEST_GENERATE_FAILED';
      e.details = generated.details || null;
      throw e;
    }
    const shiprocketOrderId = await resolveShiprocketOrderIdForOrder(order);
    const printed = await ShiprocketService.printManifest({
      shiprocketOrderId,
      channelOrderId: order.orderId
    });
    if (!printed.success) {
      const e = new Error(printed.message || 'Manifest print failed');
      e.code = printed.code || 'MANIFEST_PRINT_FAILED';
      e.details = printed.details || null;
      throw e;
    }
    manifestUrl = String(printed.manifestUrl || generated.manifestUrl || '').trim();
    if (!manifestUrl) {
      const e = new Error('Shiprocket did not return a manifest URL.');
      e.code = 'MANIFEST_URL_MISSING';
      throw e;
    }
    await applyUpsertShipmentInfo({
      order,
      shipmentPayload: {
        manifestUrl,
        manifestGeneratedAt: new Date(),
        shiprocketOrderId: printed.shiprocketOrderId || shiprocketOrderId || undefined
      },
      trigger: 'admin_manifest_pdf',
      allowOrderStatusUpdate: false
    });
  }

  const external = await axios.get(manifestUrl, {
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
    const e = new Error('Manifest download returned empty body');
    e.code = 'MANIFEST_EMPTY_BODY';
    throw e;
  }
  await syncShipmentFromShiprocket(order, 'admin_manifest_pdf_sync');
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
 * Resolve courier for Ship Now — honors checkout quote unless inactive, then cheapest active fallback.
 * @param {import('mongoose').Document} order
 * @param {number|null|undefined} courierIdOverride
 */
async function resolveCourierForShipNow(order, courierIdOverride) {
  if (courierIdOverride != null) {
    const n = Number(courierIdOverride);
    if (!Number.isFinite(n)) {
      return { success: false, code: 'INVALID_COURIER_ID', message: 'courierId must be a number when provided.' };
    }
    if (isCourierInactive({ id: n })) {
      return {
        success: false,
        code: 'COURIER_INACTIVE',
        message: 'Selected courier is inactive in our shipping policy. Pick another active courier.'
      };
    }
    return { success: true, courierId: n, substituted: false };
  }

  const quotedCourierId =
    order.shippingSnapshot?.courierCompanyId != null &&
    Number.isFinite(Number(order.shippingSnapshot.courierCompanyId)) &&
    Number(order.shippingSnapshot.courierCompanyId) > 0
      ? Number(order.shippingSnapshot.courierCompanyId)
      : null;
  const quotedCourierName = String(order.shippingSnapshot?.courierName || '').trim() || null;

  if (quotedCourierId == null && !ShiprocketService.enabled) {
    return { success: true, courierId: 1, courierName: quotedCourierName || 'Mock Courier', substituted: false };
  }

  if (
    quotedCourierId != null &&
    !isCourierInactive({ id: quotedCourierId, name: quotedCourierName, courier_name: quotedCourierName })
  ) {
    return {
      success: true,
      courierId: quotedCourierId,
      courierName: quotedCourierName,
      substituted: false
    };
  }

  const parts = await ShiprocketService.buildAdhocPayloadParts(order);
  const deliveryPin = String(parts.addr?.postalCode || '').replace(/\D/g, '').slice(0, 6);
  if (deliveryPin.length !== 6) {
    return {
      success: false,
      code: 'INVALID_DELIVERY_PINCODE',
      message: 'Order address must include a 6-digit delivery pincode.'
    };
  }

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
      message: listRes.message || 'Could not load active couriers for this route.'
    };
  }

  const picked = pickCheapestActiveCourier(listRes.couriers || [], {
    codRequired: parts.useCodAtDoor
  });
  if (!picked) {
    return {
      success: false,
      code: 'NO_ACTIVE_COURIER',
      message:
        'No active courier available for this route. Inactive couriers are excluded — enable a courier on Shiprocket or adjust shipping policy.'
    };
  }

  const note = buildCourierSubstituteNote({
    quotedId: quotedCourierId,
    quotedName: quotedCourierName,
    assignedId: picked.courierCompanyId,
    assignedName: picked.courierName
  });

  return {
    success: true,
    courierId: picked.courierCompanyId,
    courierName: picked.courierName,
    substituted: true,
    courierAssignNote: note,
    courierSubstitutedFromId: quotedCourierId,
    courierSubstitutedFromName: quotedCourierName
  };
}

/**
 * @param {import('mongoose').Document} order
 * @param {number|null|undefined} courierIdOverride
 */
async function runAssignShipFromOrder(order, courierIdOverride) {
  try {
    const { computeOpsState } = require('../services/shipmentOps/computeOpsState');
    const { OPS_STATES } = require('../services/shipmentOps/constants');

    let working = order;
    const opsState = computeOpsState(working);
    const hasStaleAwb = Boolean(working.shipmentInfo?.awbCode || working.shipmentInfo?.trackingNumber);

    if (hasStaleAwb && opsState === OPS_STATES.PROVIDER_RESET) {
      working = await applyLocalShipmentReset(working, {
        reason: working.shipmentInfo?.providerStatus || 'Shipment reset on Shiprocket',
        trigger: 'admin_ship_now_reset_clear',
        appendEvent: false
      });
      if (!working) {
        return { success: false, code: 'RESET_CLEAR_FAILED', message: 'Could not clear stale shipment before re-ship.' };
      }
    } else if (hasStaleAwb) {
      const preSync = await syncShipmentFromShiprocket(working, 'admin_ship_now_presync');
      if (preSync.resetApplied) {
        working = await Order.findOne({ orderId: order.orderId });
      }
      if (working && (working.shipmentInfo?.awbCode || working.shipmentInfo?.trackingNumber)) {
        const postOps = computeOpsState(working);
        if (postOps !== OPS_STATES.PROVIDER_RESET) {
          return {
            success: false,
            code: 'AWB_ALREADY_ASSIGNED',
            message: 'AWB already assigned for this order.'
          };
        }
        working = await applyLocalShipmentReset(working, {
          reason: working.shipmentInfo?.providerStatus || 'Shipment reset on Shiprocket',
          trigger: 'admin_ship_now_reset_clear',
          appendEvent: false
        });
      }
    }

    let shipmentId = working.shipmentInfo?.shipmentId ? String(working.shipmentInfo.shipmentId).trim() : '';
    if (!shipmentId && working.shipmentInfo?.shiprocketOrderId) {
      const lookup = await ShiprocketService.fetchShipmentIdForForwardOrder({
        shiprocketOrderId: working.shipmentInfo.shiprocketOrderId,
        channelOrderId: working.orderId
      });
      if (lookup.success && lookup.shipmentId) {
        shipmentId = String(lookup.shipmentId).trim();
        await applyUpsertShipmentInfo({
          order: working,
          shipmentPayload: { shipmentId: lookup.shipmentId },
          trigger: 'admin_resolve_shipment_id',
          allowOrderStatusUpdate: false
        });
      }
    }
    if (!shipmentId) {
      return { success: false, code: 'SHIPMENT_ID_MISSING', message: 'Create/push shipment first (no shipment_id on order).' };
    }
    if (working.shipmentInfo?.awbCode || working.shipmentInfo?.trackingNumber) {
      return { success: false, code: 'AWB_ALREADY_ASSIGNED', message: 'AWB already assigned for this order.' };
    }

    const parts = await ShiprocketService.buildAdhocPayloadParts(working);
    const deliveryPin = String(parts.addr?.postalCode || '').replace(/\D/g, '').slice(0, 6);
    if (deliveryPin.length !== 6) {
      return { success: false, code: 'INVALID_DELIVERY_PINCODE', message: 'Order address must include a 6-digit delivery pincode.' };
    }

    const courierResolve = await resolveCourierForShipNow(working, courierIdOverride);
    if (!courierResolve.success) {
      return {
        success: false,
        code: courierResolve.code || 'COURIER_RESOLVE_FAILED',
        message: courierResolve.message || 'Could not resolve courier for Ship Now.'
      };
    }

    const courierId = courierResolve.courierId;
    const quotedCourierName = String(working.shippingSnapshot?.courierName || '').trim() || null;

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
      order: working,
      shipmentPayload: {
        ...assign,
        courier: assign.courier || courierResolve.courierName || quotedCourierName,
        assignedCourierId: String(courierId),
        shiprocketOrderId: working.shipmentInfo?.shiprocketOrderId || undefined,
        events: [],
        pickupDate: null,
        pickupScheduledAt: null,
        ...(courierResolve.substituted
          ? {
              courierAssignNote: courierResolve.courierAssignNote,
              courierSubstitutedFromId: courierResolve.courierSubstitutedFromId,
              courierSubstitutedFromName: courierResolve.courierSubstitutedFromName
            }
          : {
              courierAssignNote: null,
              courierSubstitutedFromId: null,
              courierSubstitutedFromName: null
            })
      },
      trigger: 'admin_assign_awb',
      allowOrderStatusUpdate: false
    });

    await syncShipmentFromShiprocket(working, 'admin_assign_awb_sync');

    let fresh = await Order.findOne({ orderId: working.orderId });
    if (fresh) {
      const { mapProviderStatusToOrderStatus } = require('../services/shipmentOps/shiprocketStatusMap');
      const mapped = mapProviderStatusToOrderStatus(fresh.shipmentInfo?.providerStatus);
      const st = String(fresh.orderStatus || '').toLowerCase();
      if (mapped === 'processing' && st !== 'processing' && st !== 'delivered' && st !== 'cancelled') {
        fresh.orderStatus = 'processing';
        fresh.markModified('orderStatus');
        await fresh.save();
        fresh = await Order.findOne({ orderId: working.orderId });
      } else if (
        fresh.shipmentInfo?.awbCode &&
        ['pending', 'confirmed'].includes(st)
      ) {
        fresh.orderStatus = 'processing';
        fresh.markModified('orderStatus');
        await fresh.save();
        fresh = await Order.findOne({ orderId: working.orderId });
      }
      await evaluateAndPersistShipmentOps(fresh, { source: 'admin_assign_awb_status' });
    }

    return {
      success: true,
      message: courierResolve.substituted
        ? `Courier assigned (substituted): ${courierResolve.courierName || assign.courier || 'AWB generated'}`
        : 'Courier assigned and AWB generated',
      courierId,
      courierSubstituted: Boolean(courierResolve.substituted),
      courierAssignNote: courierResolve.courierAssignNote || null,
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
    await syncShipmentFromShiprocket(order, 'admin_bulk_pickup_refresh');
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

  const srDateCheck = await ShiprocketService.validatePickupDateForSchedule(pickupDate);
  if (!srDateCheck.ok) {
    return {
      orderId: id,
      success: false,
      skipped: false,
      code: srDateCheck.code || 'PICKUP_DATE_NOT_ALLOWED',
      message: srDateCheck.message || 'Pickup date not allowed by Shiprocket settings.'
    };
  }

  const sched = await ShiprocketService.schedulePickup({ shipmentId, pickupDate: srDateCheck.date });
  const outcome = await applyPickupScheduleOutcome(order, {
    sched,
    requestedPickupDate: pickupDate,
    trigger: 'admin_bulk_schedule_pickup'
  });

  if (!outcome.success) {
    return {
      orderId: id,
      success: false,
      skipped: false,
      code: outcome.code || 'PICKUP_FAILED',
      message: outcome.message || 'Pickup schedule failed',
      details: outcome.details || null
    };
  }

  return {
    orderId: id,
    success: true,
    skipped: Boolean(outcome.skipped),
    code: outcome.code || null,
    message: outcome.message || 'Pickup scheduled.'
  };
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
    if (!requireShipmentOpsAction(order, 'shipNow', res)) return;
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

/** POST /orders/admin/items/:orderId/fulfillment/sync-shiprocket — refresh pickup/label/manifest from Shiprocket */
exports.adminFulfillmentSyncShiprocket = async (req, res) => {
  try {
    const order = await loadStaffOrder(req, res, req.params.orderId);
    if (!order) return;
    if (!requireFulfillmentPaymentReady(order, res)) return;
    const hasSr =
      order.shipmentInfo?.shiprocketOrderId ||
      order.shipmentInfo?.shipmentId ||
      order.shipmentInfo?.awbCode;
    if (!hasSr) {
      return jsonError(res, 400, 'SHIPROCKET_ORDER_MISSING', 'No Shiprocket shipment on this order yet.');
    }
    const synced = await syncShipmentFromShiprocket(order, 'admin_manual_sync');
    const repaired = synced.resetApplied
      ? await Order.findOne({ orderId: order.orderId })
      : await repairPickupStateAfterShiprocketSync(order, synced.snapshot);
    const freshOrder = repaired || (await Order.findOne({ orderId: order.orderId }));
    const si = freshOrder?.shipmentInfo || {};
    const shipmentOps = buildShipmentOpsView(freshOrder, { source: 'admin_manual_sync' });
    const pickupMsg = synced.resetApplied
      ? 'Shiprocket reset detected — stale AWB/pickup cleared. Use Ship now to re-book.'
      : si.pickupDate
        ? `Courier pickup day updated to ${si.pickupDate} (from Shiprocket).`
        : 'Synced from Shiprocket. Confirm pickup day on Shiprocket if needed, then refresh again.';
    return res.json({
      success: true,
      synced: synced.success,
      message: synced.success ? pickupMsg : synced.message || 'Sync completed with warnings.',
      pickupDate: si.pickupDate || null,
      pickupDateSource: synced.pickupDateSource || null,
      shipmentOps,
      order: freshOrder
    });
  } catch (error) {
    logger.error('adminFulfillmentSyncShiprocket', { message: error.message, stack: error.stack });
    return jsonError(res, 500, 'FULFILLMENT_SYNC_FAILED', error.message || 'Server error');
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
    if (!requireShipmentOpsAction(order, 'schedulePickup', res)) return;
    if (isOrderPickupBookedOnShiprocket(order.shipmentInfo)) {
      await syncShipmentFromShiprocket(order, 'admin_schedule_pickup_refresh');
      const freshEarly = await Order.findOne({ orderId: order.orderId });
      const booked = isOrderPickupBookedOnShiprocket(freshEarly?.shipmentInfo);
      if (booked) {
        return res.json({
          success: true,
          alreadyScheduled: true,
          message: freshEarly?.shipmentInfo?.pickupDate
            ? `Pickup is already scheduled (${freshEarly.shipmentInfo.pickupDate}).`
            : 'Pickup is already scheduled on Shiprocket.',
          pickupDate: freshEarly?.shipmentInfo?.pickupDate || null,
          order: freshEarly
        });
      }
    }

    const pickupDate = String(req.body?.pickupDate || '').trim();
    const dateCheck = pickupDateNotInPast(pickupDate);
    if (!dateCheck.ok) {
      return jsonError(res, 400, 'INVALID_PICKUP_DATE', dateCheck.message);
    }

    const srDateCheck = await ShiprocketService.validatePickupDateForSchedule(pickupDate);
    if (!srDateCheck.ok) {
      return jsonError(res, 400, srDateCheck.code || 'PICKUP_DATE_NOT_ALLOWED', srDateCheck.message);
    }

    const sched = await ShiprocketService.schedulePickup({
      shipmentId,
      pickupDate: srDateCheck.date
    });
    const outcome = await applyPickupScheduleOutcome(order, {
      sched,
      requestedPickupDate: srDateCheck.date,
      trigger: 'admin_schedule_pickup'
    });

    if (!outcome.success) {
      return jsonError(res, 502, outcome.code || 'PICKUP_FAILED', outcome.message || 'Pickup schedule failed', {
        details: outcome.details || null
      });
    }

    const fresh = await Order.findOne({ orderId: order.orderId });
    return res.json({
      success: true,
      message: outcome.message || 'Pickup scheduled',
      pickupDate: outcome.pickupDate || fresh?.shipmentInfo?.pickupDate || null,
      pickupDateSource: outcome.pickupDateSource || null,
      requestedPickupDate: outcome.requestedPickupDate || srDateCheck.date,
      dateAdjusted: Boolean(outcome.dateAdjusted),
      alreadyScheduled: Boolean(outcome.alreadyScheduled),
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
    if (!requireShipmentOpsAction(order, 'downloadLabel', res)) return;
    const hasAwb = Boolean(order.shipmentInfo?.awbCode || order.shipmentInfo?.trackingNumber);
    if (!hasAwb) {
      return jsonError(res, 400, 'AWB_REQUIRED', 'Assign AWB before requesting a shipping label from Shiprocket.');
    }
    const shiprocketOrderId = await resolveShiprocketOrderIdForOrder(order);
    if (!shiprocketOrderId) {
      return jsonError(
        res,
        400,
        'SHIPROCKET_ORDER_ID_MISSING',
        'No Shiprocket order id on this order. Use Ship now first.'
      );
    }
    const label = await ShiprocketService.generateShippingLabel({
      shiprocketOrderId,
      channelOrderId: order.orderId,
      shipmentId: order.shipmentInfo?.shipmentId
    });
    if (!label.success) {
      return jsonError(res, 502, label.code || 'LABEL_FAILED', label.message || 'Label generation failed', {
        details: label.details || null
      });
    }
    await applyUpsertShipmentInfo({
      order,
      shipmentPayload: {
        labelUrl: label.labelUrl,
        shiprocketOrderId: label.shiprocketOrderId || shiprocketOrderId,
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
    if (!requireShipmentOpsAction(order, 'downloadLabel', res)) return;

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
      if (code === 'SHIPROCKET_ORDER_ID_MISSING') {
        return jsonError(res, 400, code, fetchErr.message || 'No Shiprocket order id on order.');
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
    if (!requireFulfillmentPaymentReady(order, res)) return;
    if (!requireShipmentOpsAction(order, 'cancelShipment', res)) return;
    const srOid = order.shipmentInfo?.shiprocketOrderId;
    if (!srOid) {
      return jsonError(res, 400, 'SHIPROCKET_ORDER_ID_MISSING', 'No Shiprocket order id stored; cannot cancel remotely.');
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

    const fresh = await finalizeShipmentAfterRemoteCancel(order);
    const ops = fresh ? buildShipmentOpsView(fresh, { source: 'admin_cancel_shipment' }) : null;

    return res.json({
      success: true,
      message:
        'Shipment cancelled on Shiprocket. Stale AWB/manifest data cleared — use Ship now to book again if needed.',
      raw: cancel.raw || null,
      order: fresh,
      shipmentOps: ops,
      readyForReship: Boolean(ops?.actionCapabilities?.shipNow)
    });
  } catch (error) {
    logger.error('adminFulfillmentCancelShipment', { message: error.message, stack: error.stack });
    return jsonError(res, 500, 'FULFILLMENT_CANCEL_FAILED', error.message || 'Server error');
  }
};

/** POST /orders/admin/items/:orderId/fulfillment/retry-pickup — Shiprocket pickup retry (status: retry) */
exports.adminFulfillmentRetryPickup = async (req, res) => {
  try {
    const order = await loadStaffOrder(req, res, req.params.orderId);
    if (!order) return;
    if (!requireFulfillmentPaymentReady(order, res)) return;
    if (!requireShipmentOpsAction(order, 'retryPickup', res)) return;

    const preSync = await syncShipmentFromShiprocket(order, 'admin_retry_pickup_presync');
    if (!preSync.success) {
      return jsonError(
        res,
        502,
        preSync.code || 'SYNC_BEFORE_RETRY_FAILED',
        preSync.message || 'Could not verify Shiprocket state before retry.'
      );
    }

    let working = await Order.findOne({ orderId: order.orderId });
    if (!working) {
      return jsonError(res, 404, 'ORDER_NOT_FOUND', 'Order not found');
    }

    const { computeOpsState } = require('../services/shipmentOps/computeOpsState');
    const { OPS_STATES } = require('../services/shipmentOps/constants');
    const postSyncOps = computeOpsState(working);
    if (preSync.resetApplied || postSyncOps === OPS_STATES.PROVIDER_RESET) {
      return jsonError(
        res,
        409,
        'PICKUP_RETRY_NOT_APPLICABLE',
        'Shipment was reset or auto-cancelled on Shiprocket. Use Ship now to re-book — retry pickup does not apply.',
        { shipmentOps: buildShipmentOpsView(working, { source: 'admin_retry_pickup_blocked' }) }
      );
    }

    const shipmentId = working.shipmentInfo?.shipmentId;
    if (!shipmentId) {
      return jsonError(
        res,
        400,
        'SHIPMENT_ID_MISSING',
        'No shipment_id on order. Refresh Shiprocket sync first.'
      );
    }

    const retry = await ShiprocketService.retryPickup({ shipmentId });
    if (!retry.success) {
      return jsonError(res, 502, retry.code || 'PICKUP_RETRY_FAILED', retry.message || 'Pickup retry failed', {
        details: retry.details || null
      });
    }

    await syncShipmentFromShiprocket(working, 'admin_retry_pickup_sync');
    const fresh = await Order.findOne({ orderId: order.orderId });
    const ops = fresh ? buildShipmentOpsView(fresh, { source: 'admin_retry_pickup' }) : null;

    if (ops?.opsState === OPS_STATES.PROVIDER_RESET) {
      return jsonError(
        res,
        409,
        'PICKUP_RETRY_NOT_APPLICABLE',
        'Shiprocket reset this shipment after retry. Use Ship now to re-book.',
        { order: fresh, shipmentOps: ops }
      );
    }

    const payload = {
      providerStatus: retry.providerStatus || fresh?.shipmentInfo?.providerStatus || 'pickup_scheduled',
      lastPickupError: null
    };
    if (retry.pickupDate) {
      payload.pickupDate = retry.pickupDate;
      payload.pickupScheduledAt = new Date();
    }

    await applyUpsertShipmentInfo({
      order: fresh || working,
      shipmentPayload: payload,
      trigger: 'admin_retry_pickup',
      allowOrderStatusUpdate: false
    });

    const finalOrder = await Order.findOne({ orderId: order.orderId });
    const finalOps = finalOrder ? buildShipmentOpsView(finalOrder, { source: 'admin_retry_pickup' }) : ops;

    return res.json({
      success: true,
      message: retry.pickupDate
        ? `Pickup retry submitted. Courier day: ${retry.pickupDate}.`
        : 'Pickup retry submitted on Shiprocket. Refresh tracking if status does not update.',
      pickupDate: retry.pickupDate || finalOrder?.shipmentInfo?.pickupDate || null,
      order: finalOrder,
      shipmentOps: finalOps
    });
  } catch (error) {
    logger.error('adminFulfillmentRetryPickup', { message: error.message, stack: error.stack });
    return jsonError(res, 500, 'FULFILLMENT_RETRY_PICKUP_FAILED', error.message || 'Server error');
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
    const activeCouriers = filterActiveCouriers(listRes.couriers || []);
    return res.json({
      success: true,
      recommendedCourierId: ShiprocketService.pickRecommendedCourierId(activeCouriers, {
        codRequired: parts.useCodAtDoor
      }),
      couriers: activeCouriers,
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

/** POST /orders/admin/items/bulk-documents/manifests-zip — ZIP of Shiprocket manifest PDFs */
exports.adminBulkManifestsZip = async (req, res) => {
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
            message: `Cannot download manifest for status ${order.orderStatus}`
          };
        }
        const pdfBuf = await fetchShiprocketManifestPdfBuffer(order);
        const entryName = safeZipEntryBase(oid, '-manifest.pdf');
        return { orderId: oid, success: true, entryName, pdfBuf };
      } catch (err) {
        const code = err.code || 'MANIFEST_FAILED';
        return { orderId: oid, success: false, code, message: err?.message || String(err) };
      }
    });

    const succeeded = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);
    if (succeeded.length === 0) {
      return jsonError(res, 400, 'BULK_MANIFESTS_NONE', 'No manifests could be added to the ZIP.', {
        failed: failed.map((r) => ({ orderId: r.orderId, code: r.code, message: r.message }))
      });
    }

    const zip = new AdmZip();
    const manifest = {
      type: 'shiprocket_manifests',
      generatedAt: new Date().toISOString(),
      summary: { total: results.length, succeeded: succeeded.length, failed: failed.length },
      succeeded: succeeded.map((r) => ({ orderId: r.orderId, file: r.entryName })),
      failed: failed.map((r) => ({ orderId: r.orderId, code: r.code, message: r.message }))
    };
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
    for (const row of succeeded) {
      zip.addFile(row.entryName, row.pdfBuf);
    }
    const buf = zip.toBuffer();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="shiprocket-manifests-bulk-${Date.now()}.zip"`);
    return res.status(200).send(buf);
  } catch (error) {
    logger.error('adminBulkManifestsZip', { message: error.message, stack: error.stack });
    return jsonError(res, 500, 'BULK_MANIFESTS_ZIP_FAILED', error.message || 'Server error');
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

/** GET /orders/admin/fulfillment/pickup-calendar — allowed dates from Shiprocket panel rules */
exports.adminFulfillmentPickupCalendar = async (req, res) => {
  try {
    if (!assertStaffJson(req, res)) return;
    const daysAhead = Math.min(Math.max(7, Number(req.query?.daysAhead) || 45), 90);
    const forceRefresh = String(req.query?.refresh || '').toLowerCase() === '1';
    const cal = await ShiprocketService.getPickupCalendar({ daysAhead, forceRefresh });
    const prefs = cal.preferences || {};
    return res.json({
      success: true,
      preferences: prefs,
      calendar: cal.calendar,
      scheduleFromShiprocketPanel: Boolean(prefs.hasScheduleRules),
      scheduleRulesMessage: prefs.hasScheduleRules
        ? 'Pickup dates follow your Shiprocket panel schedule.'
        : ShiprocketService.enabled
          ? 'Could not read pickup day rules from Shiprocket API. Update pickup preferences in the Shiprocket panel, then refresh this page.'
          : 'Shiprocket is disabled in server config.'
    });
  } catch (error) {
    logger.error('adminFulfillmentPickupCalendar', { message: error.message, stack: error.stack });
    return jsonError(res, 500, 'PICKUP_CALENDAR_FAILED', error.message || 'Server error');
  }
};

/** POST /orders/admin/items/:orderId/fulfillment/manifest — generate + print manifest, save URL */
exports.adminFulfillmentManifest = async (req, res) => {
  try {
    const order = await loadStaffOrder(req, res, req.params.orderId);
    if (!order) return;
    if (!requireFulfillmentPaymentReady(order, res)) return;
    if (!requireShipmentOpsAction(order, 'generateManifest', res)) return;
    if (!(order.shipmentInfo?.awbCode || order.shipmentInfo?.trackingNumber)) {
      return jsonError(res, 400, 'AWB_REQUIRED', 'Assign AWB before generating a manifest.');
    }
    const shipmentId = order.shipmentInfo?.shipmentId;
    if (!shipmentId) {
      return jsonError(res, 400, 'SHIPMENT_ID_MISSING', 'No shipment_id on order.');
    }

    const generated = await ShiprocketService.generateManifest({ shipmentId });
    if (!generated.success) {
      return jsonError(res, 502, generated.code || 'MANIFEST_GENERATE_FAILED', generated.message, {
        details: generated.details || null
      });
    }

    const shiprocketOrderId = await resolveShiprocketOrderIdForOrder(order);
    const printed = await ShiprocketService.printManifest({
      shiprocketOrderId,
      channelOrderId: order.orderId
    });
    if (!printed.success) {
      return jsonError(res, 502, printed.code || 'MANIFEST_PRINT_FAILED', printed.message, {
        details: printed.details || null
      });
    }

    const manifestUrl = String(printed.manifestUrl || generated.manifestUrl || '').trim();
    if (!manifestUrl) {
      return jsonError(res, 502, 'MANIFEST_URL_MISSING', 'Shiprocket did not return a manifest URL.');
    }

    await applyUpsertShipmentInfo({
      order,
      shipmentPayload: {
        manifestUrl,
        manifestGeneratedAt: new Date(),
        shiprocketOrderId: printed.shiprocketOrderId || shiprocketOrderId || undefined
      },
      trigger: 'admin_manifest',
      allowOrderStatusUpdate: false
    });
    await syncShipmentFromShiprocket(order, 'admin_manifest_sync');

    const fresh = await Order.findOne({ orderId: order.orderId });
    return res.json({
      success: true,
      manifestUrl,
      order: fresh
    });
  } catch (error) {
    logger.error('adminFulfillmentManifest', { message: error.message, stack: error.stack });
    return jsonError(res, 500, 'FULFILLMENT_MANIFEST_FAILED', error.message || 'Server error');
  }
};

/**
 * GET /orders/admin/items/:orderId/fulfillment/manifest-file
 * Proxies Shiprocket manifest PDF for admin download.
 */
exports.adminFulfillmentManifestFile = async (req, res) => {
  try {
    const order = await loadStaffOrder(req, res, req.params.orderId);
    if (!order) return;
    if (!requireFulfillmentPaymentReady(order, res)) return;
    if (!requireShipmentOpsAction(order, 'downloadManifest', res)) return;

    let buf;
    try {
      buf = await fetchShiprocketManifestPdfBuffer(order);
    } catch (fetchErr) {
      const code = fetchErr.code || 'MANIFEST_FILE_FAILED';
      if (code === 'AWB_REQUIRED' || code === 'SHIPMENT_ID_MISSING' || code === 'SHIPROCKET_ORDER_ID_MISSING') {
        return jsonError(res, 400, code, fetchErr.message);
      }
      const payHttp = fulfillmentPaymentBlockHttpStatus(code);
      if (payHttp === 403) {
        return jsonError(res, 403, code, fetchErr.message, {
          details: fetchErr.details != null ? fetchErr.details : null
        });
      }
      return jsonError(res, 502, code, fetchErr.message || 'Manifest error', {
        details: fetchErr.details || null
      });
    }

    const safe = String(order.orderId || 'order').replace(/[^\w.-]+/g, '_').slice(0, 80);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Shiprocket-manifest-${safe}.pdf"`);
    return res.status(200).send(buf);
  } catch (error) {
    logger.error('adminFulfillmentManifestFile', { message: error.message, stack: error.stack });
    return jsonError(res, 500, 'MANIFEST_FILE_FAILED', error.message || 'Server error');
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
