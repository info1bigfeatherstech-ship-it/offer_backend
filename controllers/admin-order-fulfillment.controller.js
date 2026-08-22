/**
 * Admin-only Shiprocket fulfillment: ensure create, assign AWB (ship), scheduled pickup, label, cancel.
 * Uses shared shipment sync from order.controller.
 */

const axios = require('axios');
const AdmZip = require('adm-zip');
const Order = require('../models/Order');
const ShiprocketService = require('../utils/shiprocket');
const ShipmozoService = require('../utils/shipmozo');
const { runShipmozoAssignShip } = require('../services/shipmozoFulfillment.service');
const { runShiprocketAssignAwb } = require('../services/shiprocketFulfillment.service');
const {
  SHIPPING_PROVIDERS,
  resolveOrderShippingProvider,
  isShipmozoOrder
} = require('../constants/shippingProviders');
const logger = require('../utils/logger');
const { isOrderStaffRequest } = require('../utils/checkoutFlow');
const { buildGstInvoiceHtml, buildGstInvoiceViewModel } = require('../utils/gstInvoice');
const { applyUpsertShipmentInfo, ensureShipmentForOrderExport } = require('./order.controller');
const {
  evaluateOrderPaymentForShiprocketFulfillment,
  fulfillmentPaymentBlockHttpStatus
} = require('../utils/orderFulfillmentPaymentGate');
const { isUnpaidTerminalOrder } = require('../utils/orderPaymentState');
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
  detectForwardOrderReset,
  persistPickupDateFromSnapshot,
  ensureForwardPickupStateForSchedule,
  ensureShiprocketPickupId
} = require('../services/shiprocketReconcile.service');
const { computeOpsState } = require('../services/shipmentOps/computeOpsState');
const { mergeReturnInfo } = require('../services/rtoRefund.service');
const { isCustomerProductReturnRequest } = require('../utils/productReturnRequest');
const {
  resolveActualFreightForCourier,
  settleOosShippingAfterActualFreight,
  trySettlePendingOosOrder
} = require('../services/oosShippingSettlement.service');
const {
  getAdminOrderMatch,
  mergeOrderScopeFilter
} = require('../utils/adminOrderScope');
const {
  filterActiveCouriers
} = require('../services/courierPolicy.service');
const shipmozoLabelSettingsService = require('../services/shipmozoLabelSettings.service');
const { buildLabelViewModel } = require('../services/shipmozoLabelViewModel.service');
const { renderLabelPdf } = require('../services/shipmozoLabelPdf.service');

function manifestAlreadyGeneratedMessage(message) {
  return /manifest already generated|already been generated/i.test(String(message || ''));
}

/**
 * Pull label/manifest URLs Shiprocket already has (e.g. generated on Shiprocket panel).
 * @param {import('mongoose').Document} order
 */
async function pullPanelFulfillmentUrlsFromSnapshot(order) {
  const si = order.shipmentInfo || {};
  const currentAwb = String(si.awbCode || si.trackingNumber || '').trim();
  if (!currentAwb) return null;
  const lookup = await ShiprocketService.fetchForwardOrderSnapshot({
    shiprocketOrderId: si.shiprocketOrderId,
    channelOrderId: order.orderId
  });
  if (!lookup.success || !lookup.snapshot) return null;
  const snapAwb = String(lookup.snapshot.awbCode || '').trim();
  if (!snapAwb || snapAwb !== currentAwb) return null;
  return {
    awbCode: snapAwb,
    labelUrl: lookup.snapshot.labelUrl || null,
    manifestUrl: lookup.snapshot.manifestUrl || null
  };
}

/**
 * Resolve manifest URL — prefers Shiprocket panel state, falls back to print when already generated.
 * @param {import('mongoose').Document} order
 */
async function resolveManifestUrlForOrder(order) {
  const shipmentId = order.shipmentInfo?.shipmentId;
  const shiprocketOrderId = await resolveShiprocketOrderIdForOrder(order);
  if (!shipmentId) {
    return { success: false, code: 'SHIPMENT_ID_MISSING', message: 'No shipment_id on order.' };
  }
  if (!shiprocketOrderId) {
    return {
      success: false,
      code: 'SHIPROCKET_ORDER_ID_MISSING',
      message: 'No Shiprocket order id on this order.'
    };
  }

  const panel = await pullPanelFulfillmentUrlsFromSnapshot(order);
  if (panel?.manifestUrl) {
    return {
      success: true,
      manifestUrl: String(panel.manifestUrl).trim(),
      shiprocketOrderId,
      source: 'panel_snapshot'
    };
  }

  const generated = await ShiprocketService.generateManifest({ shipmentId });
  const alreadyGenerated =
    !generated.success && manifestAlreadyGeneratedMessage(generated.message);
  if (!generated.success && !alreadyGenerated) {
    return generated;
  }

  const printed = await ShiprocketService.printManifest({
    shiprocketOrderId,
    channelOrderId: order.orderId
  });
  if (!printed.success) return printed;

  const manifestUrl = String(printed.manifestUrl || generated.manifestUrl || '').trim();
  if (!manifestUrl) {
    return {
      success: false,
      code: 'MANIFEST_URL_MISSING',
      message: 'Shiprocket did not return a manifest URL.'
    };
  }
  return {
    success: true,
    manifestUrl,
    shiprocketOrderId: printed.shiprocketOrderId || shiprocketOrderId,
    source: alreadyGenerated ? 'print_existing' : 'generate_and_print'
  };
}

/**
 * Resolve label URL — prefers Shiprocket panel snapshot for current AWB.
 * @param {import('mongoose').Document} order
 */
async function resolveLabelUrlForOrder(order) {
  const shiprocketOrderId = await resolveShiprocketOrderIdForOrder(order);
  if (!shiprocketOrderId) {
    return {
      success: false,
      code: 'SHIPROCKET_ORDER_ID_MISSING',
      message: 'No Shiprocket order id on this order.'
    };
  }
  const currentAwb = String(order.shipmentInfo?.awbCode || order.shipmentInfo?.trackingNumber || '').trim();

  const panel = await pullPanelFulfillmentUrlsFromSnapshot(order);
  if (
    panel?.labelUrl &&
    !ShiprocketService.isLikelyTaxInvoiceUrl(panel.labelUrl)
  ) {
    return {
      success: true,
      labelUrl: String(panel.labelUrl).trim(),
      shiprocketOrderId,
      source: 'panel_snapshot'
    };
  }

  return ShiprocketService.generateShippingLabel({
    shiprocketOrderId,
    channelOrderId: order.orderId,
    shipmentId: order.shipmentInfo?.shipmentId,
    expectedAwb: currentAwb
  });
}

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
  const order = await Order.findOne(
    mergeOrderScopeFilter({ orderId: id }, getAdminOrderMatch(req))
  ).populate('items.productId', 'name slug shipping variants');
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

async function loadOrderDocByOrderId(orderId, scopeMatch = null) {
  const id = String(orderId || '').trim();
  if (!id) return null;
  const filter = mergeOrderScopeFilter({ orderId: id }, scopeMatch);
  return Order.findOne(filter).populate(FULFILLMENT_ITEM_POPULATE);
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
/** True only when ops state confirms pickup is active on Shiprocket (not stale local pickupDate). */
function isOrderPickupBookedOnShiprocket(orderOrShipmentInfo) {
  const order =
    orderOrShipmentInfo && orderOrShipmentInfo.shipmentInfo
      ? orderOrShipmentInfo
      : { shipmentInfo: orderOrShipmentInfo || {} };
  const opsState = computeOpsState(order);
  return opsState === 'PICKUP_SCHEDULED' || opsState === 'MANIFEST_READY';
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
  const hasLocalAwb = Boolean(si.awbCode || si.trackingNumber);
  const hasLocalForwardArtifacts = Boolean(
    si.pickupDate || si.pickupScheduledAt || si.manifestUrl || si.labelUrl
  );

  const resetCheck = detectForwardOrderReset({
    statusCode: snap?.statusCode,
    statusLabel: snap?.providerStatus || si.providerStatus,
    statusMessage: snap?.statusMessage,
    texts: snap?.signalTexts,
    awbCode: snap?.awbCode || null,
    hadLocalAwb: hasLocalAwb,
    hadLocalPickup: Boolean(si.pickupDate || si.pickupScheduledAt),
    hadLocalManifestOrLabel: Boolean(si.manifestUrl || si.labelUrl),
    apiPickupScheduled: snap?.pickupScheduled === true || Boolean(snap?.pickupDate),
    apiPickupDate: snap?.pickupDate || null
  });

  const staleNoAwbCycle =
    !snap?.awbCode &&
    !hasLocalAwb &&
    (hasLocalForwardArtifacts ||
      snap?.resetDetected ||
      snap?.pickupScheduled ||
      snap?.pickupDate ||
      /pickup\s*scheduled|pickup\s*generated/i.test(String(snap?.providerStatus || '')));

  if (snap?.resetDetected || resetCheck.resetDetected || staleNoAwbCycle) {
    if (hasLocalAwb || hasLocalForwardArtifacts) {
      return applyLocalShipmentReset(fresh, {
        reason:
          resetCheck.reason ||
          snap?.resetReason ||
          snap?.statusMessage ||
          'Shipment reset on Shiprocket',
        trigger: 'admin_sync_stale_pickup_reset',
        appendEvent: true
      });
    }
    return fresh;
  }

  await persistPickupDateFromSnapshot(order, snap, 'admin_pickup_state_repair');

  fresh = await Order.findOne({ orderId: order.orderId });
  if (!fresh) return null;
  const si2 = fresh.shipmentInfo || {};
  const queueErr = ShiprocketService.isPickupAlreadyScheduledMessage(si2.lastPickupError);
  const manifestDone = Boolean(si2.manifestUrl);
  const needsBookedAt =
    (queueErr || manifestDone || isOrderPickupBookedOnShiprocket(fresh)) && !si2.pickupScheduledAt;
  const needsErrorClear = queueErr;

  if (!needsBookedAt && !needsErrorClear) {
    await ensureShiprocketPickupId(fresh, 'admin_pickup_state_repair_id');
    return Order.findOne({ orderId: order.orderId });
  }

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
  await ensureShiprocketPickupId(fresh, 'admin_pickup_state_repair_id');
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
      ShiprocketService.parsePickupDateFromScheduleResponse(sched.raw, null) ||
      sched.pickupDate ||
      requested ||
      null;
    const synced = await syncShipmentFromShiprocket(order, `${trigger || 'admin_schedule_pickup'}_sync`);
    const snap = synced.snapshot;
    if (snap?.pickupScheduled === true && snap.pickupDate) {
      confirmedDate = snap.pickupDate;
    } else if (!confirmedDate && synced.pickupDate && snap?.pickupScheduled !== false) {
      confirmedDate = synced.pickupDate;
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
    let fresh = await Order.findOne({ orderId: order.orderId });
    const snap = synced.snapshot;
    const opsState = fresh ? computeOpsState(fresh) : null;

    if (snap?.pickupScheduled === false || opsState === 'AWB_ASSIGNED') {
      await ensureForwardPickupStateForSchedule(fresh || order, `${trigger || 'admin_schedule_pickup'}_clear_stale`);
      fresh = await Order.findOne({ orderId: order.orderId });
      return {
        success: false,
        code: 'PICKUP_NOT_CONFIRMED',
        message:
          'Shiprocket reported a pickup conflict, but pickup is not active on this order. Stale pickup data was cleared — click Schedule pickup again.',
        pickupDate: null,
        stalePickupCleared: true,
        details: schedMsg || null
      };
    }

    const savedDate =
      (snap?.pickupScheduled && snap?.pickupDate) ||
      synced.pickupDate ||
      fresh?.shipmentInfo?.pickupDate ||
      null;
    if (savedDate && fresh) {
      await applyUpsertShipmentInfo({
        order: fresh,
        shipmentPayload: {
          pickupDate: savedDate,
          pickupScheduledAt: fresh.shipmentInfo?.pickupScheduledAt || new Date(),
          lastPickupError: null,
          providerStatus: snap?.providerStatus || fresh.shipmentInfo?.providerStatus
        },
        trigger: trigger || 'admin_schedule_pickup_already',
        allowOrderStatusUpdate: false
      });
      await evaluateAndPersistShipmentOps(fresh, { source: trigger || 'admin_schedule_pickup_already' });
    }
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
 * Detect label file type from data-URL meta, HTTP content-type, or magic bytes.
 * Shipmozo often returns PNG data URLs; Shiprocket returns PDF.
 * @param {Buffer} buf
 * @param {string} [hint] — e.g. data URL mime or axios Content-Type
 * @returns {{ contentType: string, extension: string }}
 */
function resolveLabelFileMeta(buf, hint) {
  const h = String(hint || '')
    .trim()
    .toLowerCase()
    .split(';')[0]
    .trim();
  if (h === 'image/png' || h.includes('image/png')) {
    return { contentType: 'image/png', extension: 'png' };
  }
  if (h === 'image/jpeg' || h === 'image/jpg' || h.includes('image/jpeg') || h.includes('image/jpg')) {
    return { contentType: 'image/jpeg', extension: 'jpg' };
  }
  if (h === 'image/webp' || h.includes('image/webp')) {
    return { contentType: 'image/webp', extension: 'webp' };
  }
  if (h === 'application/pdf' || h.includes('application/pdf')) {
    return { contentType: 'application/pdf', extension: 'pdf' };
  }

  const b = Buffer.isBuffer(buf) ? buf : Buffer.from([]);
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { contentType: 'image/png', extension: 'png' };
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return { contentType: 'image/jpeg', extension: 'jpg' };
  }
  if (b.length >= 4 && b.slice(0, 4).toString('ascii') === '%PDF') {
    return { contentType: 'application/pdf', extension: 'pdf' };
  }
  if (b.length >= 12 && b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP') {
    return { contentType: 'image/webp', extension: 'webp' };
  }
  // Unknown — caller may fall back for Shipmozo
  return { contentType: 'application/octet-stream', extension: 'bin' };
}

/**
 * Fetch Shipmozo label bytes (data-URL / base64 / http URL). Never calls Shiprocket.
 * @param {import('mongoose').Document} order
 * @returns {Promise<{ buffer: Buffer, contentType: string, extension: string }>}
 */
async function fetchShipmozoLabelFile(order) {
  const gate = evaluateOrderPaymentForShiprocketFulfillment(order);
  if (!gate.ok) {
    const e = new Error(gate.message || 'Payment rules do not allow this shipment action.');
    e.code = gate.code || 'PAYMENT_REQUIRED';
    e.details = gate.details || null;
    throw e;
  }
  const awb = String(order.shipmentInfo?.awbCode || order.shipmentInfo?.trackingNumber || '').trim();
  if (!awb) {
    const e = new Error('Assign AWB before downloading or opening a shipping label.');
    e.code = 'AWB_REQUIRED';
    throw e;
  }

  try {
    const storefront =
      String(order.storefront || '').toLowerCase() === 'wholesale' ? 'wholesale' : 'ecomm';
    const saved = await shipmozoLabelSettingsService.getPublicSettings(storefront);
    const vm = await buildLabelViewModel(order, saved.settings);
    const pdfBuf = await renderLabelPdf(vm);
    if (pdfBuf && Buffer.isBuffer(pdfBuf) && pdfBuf.length > 80) {
      return { buffer: pdfBuf, contentType: 'application/pdf', extension: 'pdf' };
    }
    logger.warn('custom Shipmozo label PDF empty, falling back to provider PNG', {
      orderId: order?.orderId,
      awb
    });
  } catch (customErr) {
    if (customErr?.code === 'AWB_REQUIRED' || customErr?.code === 'PAYMENT_REQUIRED') {
      throw customErr;
    }
    logger.error('custom Shipmozo 4x6 label failed; falling back to Shipmozo PNG', {
      orderId: order?.orderId,
      awb,
      message: customErr?.message
    });
  }

  // Always fetch live from Shipmozo (do not persist/reuse huge base64 labelUrl in Mongo).
  let labelPayload = '';
  try {
    const label = await ShipmozoService.getOrderLabel(awb);
    if (!label.success || !label.labelUrl) {
      const e = new Error(label.message || 'Could not get Shipmozo shipping label');
      e.code = label.code || 'LABEL_FAILED';
      e.details = label.raw || null;
      throw e;
    }
    labelPayload = String(label.labelUrl).trim();
  } catch (err) {
    if (err.code) throw err;
    logger.error('fetchShipmozoLabelFile', { orderId: order?.orderId, awb, message: err.message });
    const e = new Error(err.message || 'Could not download Shipmozo label');
    e.code = 'LABEL_FILE_FAILED';
    throw e;
  }
  if (!labelPayload) {
    const e = new Error('Could not get Shipmozo shipping label');
    e.code = 'LABEL_FAILED';
    throw e;
  }

  // Drop any previously cached Shipmozo base64 label from DB (keep DB lean).
  const cached = order.shipmentInfo?.labelUrl ? String(order.shipmentInfo.labelUrl).trim() : '';
  if (cached && (/^data:/i.test(cached) || cached.length > 500)) {
    try {
      await applyUpsertShipmentInfo({
        order,
        shipmentPayload: {
          labelUrl: null,
          provider: SHIPPING_PROVIDERS.SHIPMOZO,
          fulfillmentLabelAwb: awb,
          providerStatus: order.shipmentInfo?.providerStatus
        },
        trigger: 'admin_shipping_label_clear_shipmozo_cache',
        allowOrderStatusUpdate: false
      });
    } catch (_) {
      /* non-fatal */
    }
  }

  try {
    if (/^data:/i.test(labelPayload)) {
      const comma = labelPayload.indexOf(',');
      if (comma < 0) {
        const e = new Error('Shipmozo label data URL is invalid');
        e.code = 'LABEL_FAILED';
        throw e;
      }
      const meta = labelPayload.slice(0, comma);
      const dataPart = labelPayload.slice(comma + 1);
      const mimeMatch = /^data:([^;,]+)/i.exec(meta);
      const mimeHint = mimeMatch ? mimeMatch[1].trim() : '';
      const buf = /;base64/i.test(meta)
        ? Buffer.from(dataPart, 'base64')
        : Buffer.from(decodeURIComponent(dataPart), 'utf8');
      if (!buf.length) {
        const e = new Error('Shipmozo label download returned empty body');
        e.code = 'LABEL_EMPTY_BODY';
        throw e;
      }
      const resolved = resolveLabelFileMeta(buf, mimeHint);
      return { buffer: buf, contentType: resolved.contentType, extension: resolved.extension };
    }
    if (/^https?:\/\//i.test(labelPayload)) {
      const external = await axios.get(labelPayload, {
        responseType: 'arraybuffer',
        timeout: 45000,
        maxContentLength: 25 * 1024 * 1024,
        headers: {
          Accept: 'application/pdf,application/octet-stream,image/*,*/*',
          'User-Agent': 'Mozilla/5.0 (compatible; OfferWaleBaba/1.0; +https://offerwalebaba.com)'
        },
        validateStatus: (s) => s >= 200 && s < 400
      });
      const buf = Buffer.from(external.data || []);
      if (!buf.length) {
        const e = new Error('Shipmozo label download returned empty body');
        e.code = 'LABEL_EMPTY_BODY';
        throw e;
      }
      const ctHeader = String(external.headers?.['content-type'] || '');
      const resolved = resolveLabelFileMeta(buf, ctHeader);
      return { buffer: buf, contentType: resolved.contentType, extension: resolved.extension };
    }
    // Raw base64 (no data: prefix) — sniff magic bytes after decode
    const buf = Buffer.from(labelPayload.replace(/\s+/g, ''), 'base64');
    if (!buf.length) {
      const e = new Error('Shipmozo label payload could not be decoded');
      e.code = 'LABEL_FAILED';
      throw e;
    }
    const resolved = resolveLabelFileMeta(buf, '');
    if (resolved.extension === 'bin') {
      // Most Shipmozo labels are PNG when mime is omitted
      const asPng = resolveLabelFileMeta(buf, 'image/png');
      if (buf[0] === 0x89) {
        return { buffer: buf, contentType: asPng.contentType, extension: asPng.extension };
      }
    }
    return { buffer: buf, contentType: resolved.contentType, extension: resolved.extension };
  } catch (err) {
    if (err.code) throw err;
    logger.error('fetchShipmozoLabelFile', { orderId: order?.orderId, message: err.message });
    const e = new Error(err.message || 'Could not download Shipmozo label');
    e.code = 'LABEL_FILE_FAILED';
    throw e;
  }
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
  const currentAwb = String(order.shipmentInfo?.awbCode || order.shipmentInfo?.trackingNumber || '').trim();
  // Only check fulfillmentLabelAwb — do NOT fallback to fulfillmentArtifactAwb.
  // fulfillmentArtifactAwb gets updated by manifest generation and would
  // incorrectly mark a stale label as fresh.
  const labelAwb = String(order.shipmentInfo?.fulfillmentLabelAwb || '').trim();
  const isStale = labelAwb !== currentAwb;

  let labelUrl = '';
  if (cachedUrl && !ShiprocketService.isLikelyTaxInvoiceUrl(cachedUrl) && !isStale) {
    labelUrl = cachedUrl;
  }

  if (!labelUrl) {
    const label = await resolveLabelUrlForOrder(order);
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

  const cachedUrl = order.shipmentInfo?.manifestUrl ? String(order.shipmentInfo.manifestUrl).trim() : '';
  const currentAwb = String(order.shipmentInfo?.awbCode || order.shipmentInfo?.trackingNumber || '').trim();
  // Only check fulfillmentManifestAwb — do NOT fallback to fulfillmentArtifactAwb.
  const manifestAwb = String(order.shipmentInfo?.fulfillmentManifestAwb || '').trim();
  const isStale = manifestAwb !== currentAwb;

  let manifestUrl = '';
  if (cachedUrl && !isStale) {
    manifestUrl = cachedUrl;
  }

  if (!manifestUrl) {
    const resolved = await resolveManifestUrlForOrder(order);
    if (!resolved.success || !resolved.manifestUrl) {
      const e = new Error(resolved.message || 'Manifest resolution failed');
      e.code = resolved.code || 'MANIFEST_RESOLVE_FAILED';
      e.details = resolved.details || null;
      throw e;
    }
    manifestUrl = String(resolved.manifestUrl).trim();
    const shiprocketOrderId = resolved.shiprocketOrderId || (await resolveShiprocketOrderIdForOrder(order));
    await applyUpsertShipmentInfo({
      order,
      shipmentPayload: {
        manifestUrl,
        manifestGeneratedAt: new Date(),
        shiprocketOrderId: shiprocketOrderId || undefined
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
 * @param {import('mongoose').Document} order
 * @param {number|null|undefined} courierIdOverride
 * @param {{ confirmSubstitute?: boolean }} [opts]
 */
async function runAssignShipFromOrder(order, courierIdOverride, opts = {}) {
  try {
    // Shipmozo orders: never call Shiprocket assign APIs
    if (isShipmozoOrder(order)) {
      const assignRes = await runShipmozoAssignShip(order, {
        courierIdOverride,
        confirmSubstitute: Boolean(opts.confirmSubstitute),
        applyUpsertShipmentInfo,
        evaluateAndPersistShipmentOps
      });
      if (!assignRes.success) {
        return assignRes;
      }

      const hasAwb = Boolean(
        assignRes.shipment?.awbCode ||
          assignRes.shipment?.trackingNumber ||
          assignRes.order?.shipmentInfo?.awbCode ||
          assignRes.order?.shipmentInfo?.trackingNumber
      );

      let oosShippingSettlement = { settled: false, skipped: true, reason: 'not_run' };
      if (hasAwb) {
        try {
          const orderId = order.orderId;
          let fresh = assignRes.order || (await Order.findOne({ orderId }));
          if (fresh?.paymentInfo?.oosShippingSettlement?.pending === true) {
            const courierId = assignRes.courierId;
            const freightRes = await resolveActualFreightForCourier(fresh, courierId);
            oosShippingSettlement = await settleOosShippingAfterActualFreight(fresh, {
              actualFreightInr: freightRes.ok ? freightRes.freightInr : null,
              mock: Boolean(freightRes.mock) && !freightRes.ok,
              courierId,
              courierName:
                assignRes.shipment?.courier ||
                fresh.shipmentInfo?.courier ||
                fresh.shippingSnapshot?.courierName ||
                null,
              assignRaw: null,
              source: 'admin_shipmozo_assign'
            });
            if (oosShippingSettlement.settled) {
              fresh = await Order.findOne({ orderId });
              if (fresh) {
                await evaluateAndPersistShipmentOps(fresh, { source: 'oos_shipping_settled' });
              }
            } else if (fresh?.paymentInfo?.oosShippingSettlement?.pending === true) {
              logger.warn('[oosShippingSettlement] still pending after Shipmozo Ship Now', {
                orderId: fresh.orderId,
                reason: oosShippingSettlement.reason || freightRes.message || null,
                courierId
              });
            }
          }
        } catch (settleErr) {
          logger.error('oos shipping settlement after Shipmozo ship now failed', {
            orderId: order?.orderId,
            message: settleErr?.message || String(settleErr)
          });
          oosShippingSettlement = {
            settled: false,
            skipped: false,
            reason: 'settlement_error',
            message: settleErr?.message || String(settleErr)
          };
        }
      }

      const finalOrder = (await Order.findOne({ orderId: order.orderId })) || assignRes.order;
      return {
        ...assignRes,
        order: finalOrder,
        oosShippingSettlement
      };
    }

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

    const deliveryPin = String(working.addressSnapshot?.postalCode || working.shippingAddress?.postalCode || '')
      .replace(/\D/g, '')
      .slice(0, 6);
    if (deliveryPin.length !== 6) {
      // Soft pre-check; service also validates via buildAdhocPayloadParts
      try {
        const parts = await ShiprocketService.buildAdhocPayloadParts(working);
        const pin = String(parts.addr?.postalCode || '').replace(/\D/g, '').slice(0, 6);
        if (pin.length !== 6) {
          return {
            success: false,
            code: 'INVALID_DELIVERY_PINCODE',
            message: 'Order address must include a 6-digit delivery pincode.'
          };
        }
      } catch (pinErr) {
        return {
          success: false,
          code: 'INVALID_DELIVERY_PINCODE',
          message: pinErr?.message || 'Order address must include a 6-digit delivery pincode.'
        };
      }
    }

    // Production policy: assign quoted first; substitute only after admin confirm. Never mutate customer bill.
    const assignRes = await runShiprocketAssignAwb(working, {
      shipmentId,
      courierIdOverride:
        courierIdOverride != null && Number.isFinite(Number(courierIdOverride))
          ? Number(courierIdOverride)
          : null,
      confirmSubstitute: Boolean(opts.confirmSubstitute)
    });

    if (!assignRes.success) {
      return {
        success: false,
        code: assignRes.code || 'ASSIGN_AWB_FAILED',
        message: assignRes.message || 'Assign AWB failed',
        details: assignRes.details || null,
        quotedCourier: assignRes.quotedCourier || null,
        suggestedCourier: assignRes.suggestedCourier || null,
        availableCouriers: assignRes.availableCouriers || null,
        quotedFreightInr: assignRes.quotedFreightInr ?? null,
        customerBillUnchanged: true
      };
    }

    const assign = assignRes.assign;
    const courierId = assignRes.courierId;
    const quotedCourierName = String(working.shippingSnapshot?.courierName || '').trim() || null;

    await applyUpsertShipmentInfo({
      order: working,
      shipmentPayload: {
        ...assign,
        courier: assign.courier || assignRes.courierName || quotedCourierName,
        assignedCourierId: String(courierId),
        shiprocketOrderId: working.shipmentInfo?.shiprocketOrderId || undefined,
        events: [],
        pickupDate: null,
        pickupScheduledAt: null,
        ...(assignRes.substituted
          ? {
              courierAssignNote: assignRes.courierAssignNote,
              courierSubstitutedFromId: assignRes.courierSubstitutedFromId,
              courierSubstitutedFromName: assignRes.courierSubstitutedFromName
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

    // OOS pending-edit: settle with positive freight (actual preferred, held fallback).
    // Normal courier substitute does NOT rewrite customer checkout totals.
    let oosShippingSettlement = { settled: false, skipped: true, reason: 'not_run' };
    try {
      fresh = fresh || (await Order.findOne({ orderId: working.orderId }));
      if (fresh?.paymentInfo?.oosShippingSettlement?.pending === true) {
        const freightRes = await resolveActualFreightForCourier(fresh, courierId);
        oosShippingSettlement = await settleOosShippingAfterActualFreight(fresh, {
          actualFreightInr: freightRes.ok ? freightRes.freightInr : null,
          mock: Boolean(assign.mock) && !freightRes.ok,
          courierId,
          courierName: assignRes.courierName || assign.courier || null,
          assignRaw: assign?.raw || null,
          source: 'admin_assign_awb'
        });
        if (oosShippingSettlement.settled) {
          fresh = await Order.findOne({ orderId: working.orderId });
          if (fresh) {
            await evaluateAndPersistShipmentOps(fresh, { source: 'oos_shipping_settled' });
          }
        } else if (fresh?.paymentInfo?.oosShippingSettlement?.pending === true) {
          logger.warn('[oosShippingSettlement] still pending after Ship Now', {
            orderId: fresh.orderId,
            reason: oosShippingSettlement.reason || freightRes.message || null,
            courierId
          });
        }
      }
    } catch (settleErr) {
      logger.error('oos shipping settlement after ship now failed', {
        orderId: working?.orderId,
        message: settleErr?.message || String(settleErr)
      });
      oosShippingSettlement = {
        settled: false,
        skipped: false,
        reason: 'settlement_error',
        message: settleErr?.message || String(settleErr)
      };
    }

    return {
      success: true,
      message: assignRes.substituted
        ? `Courier assigned (substituted): ${assignRes.courierName || assign.courier || 'AWB generated'} (customer bill unchanged)`
        : 'Courier assigned and AWB generated',
      courierId,
      courierSubstituted: Boolean(assignRes.substituted),
      courierAssignNote: assignRes.courierAssignNote || null,
      shipment: assign,
      oosShippingSettlement,
      customerBillUnchanged: true,
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
 * @param {{ courierId?: number|null, scopeMatch?: object|null }} [opts]
 */
async function runBulkShipNowSingle(orderId, opts = {}) {
  try {
    const id = String(orderId || '').trim();
    if (!id) {
      return { orderId: orderId || '', success: false, skipped: false, code: 'ORDER_ID_REQUIRED', message: 'orderId is required' };
    }

    const scopeMatch = opts.scopeMatch || null;
    const order = await loadOrderDocByOrderId(id, scopeMatch);
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

  let working = await loadOrderDocByOrderId(id, scopeMatch);
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
 * @param {object|null} [scopeMatch]
 */
async function runBulkSchedulePickupSingle(orderId, pickupDateYmd, scopeMatch = null) {
  try {
  const id = String(orderId || '').trim();
  const pickupDate = String(pickupDateYmd || '').trim();
  if (!id) {
    return { orderId: orderId || '', success: false, skipped: false, code: 'ORDER_ID_REQUIRED', message: 'orderId is required' };
  }

  const order = await loadOrderDocByOrderId(id, scopeMatch);
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

  const pickupPrep = await ensureForwardPickupStateForSchedule(order, 'admin_bulk_pickup_prep');
  let workingOrder = (await Order.findOne({ orderId: order.orderId })) || order;

  if (pickupPrep.booked) {
    const savedDate = pickupPrep.pickupDate || workingOrder?.shipmentInfo?.pickupDate || null;
    return {
      orderId: id,
      success: true,
      skipped: true,
      alreadyScheduled: true,
      code: 'PICKUP_ALREADY_SET',
      message: savedDate
        ? `Pickup already scheduled on Shiprocket (${savedDate}).`
        : 'Pickup already scheduled on Shiprocket.',
      pickupDate: savedDate
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

  const sched = await ShiprocketService.schedulePickup({ shipmentId: workingOrder.shipmentInfo?.shipmentId || shipmentId, pickupDate: srDateCheck.date });
  const outcome = await applyPickupScheduleOutcome(workingOrder, {
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
    const scopeMatch = getAdminOrderMatch(req);
    const courierOpt =
      courierId != null && Number.isFinite(courierId) && courierId > 0
        ? { courierId, scopeMatch }
        : { scopeMatch };

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
    const scopeMatch = getAdminOrderMatch(req);
    const results = await mapInConcurrentWindows(orderIds, parallel, (oid) =>
      runBulkSchedulePickupSingle(oid, pickupDate, scopeMatch)
    );

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

/**
 * Single-order Shiprocket sync for bulk refresh (reconcile + SRPID backfill).
 * @param {string} orderId
 * @param {object|null} [scopeMatch]
 */
async function runBulkSyncShiprocketSingle(orderId, scopeMatch = null) {
  try {
    const id = String(orderId || '').trim();
    if (!id) {
      return { orderId: orderId || '', success: false, skipped: false, code: 'ORDER_ID_REQUIRED', message: 'orderId is required' };
    }

    const order = await loadOrderDocByOrderId(id, scopeMatch);
    if (!order) {
      return { orderId: id, success: false, skipped: false, code: 'ORDER_NOT_FOUND', message: 'Order not found' };
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

    const hasSr =
      order.shipmentInfo?.shiprocketOrderId ||
      order.shipmentInfo?.shipmentId ||
      order.shipmentInfo?.awbCode;
    if (!hasSr) {
      return {
        orderId: id,
        success: false,
        skipped: true,
        code: 'SHIPROCKET_ORDER_MISSING',
        message: 'No Shiprocket shipment on this order yet.'
      };
    }

    const synced = await syncShipmentFromShiprocket(order, 'admin_bulk_sync');
    if (!synced.success) {
      return {
        orderId: id,
        success: false,
        skipped: false,
        code: synced.code || 'SYNC_FAILED',
        message: synced.message || 'Sync failed'
      };
    }

    if (!synced.resetApplied) {
      await repairPickupStateAfterShiprocketSync(order, synced.snapshot);
    }

    await ensureShiprocketPickupId(id, 'admin_bulk_sync_pickup_id');
    const fresh = await Order.findOne({ orderId: id });
    const pickupId = fresh?.shipmentInfo?.shiprocketPickupId || null;

    return {
      orderId: id,
      success: true,
      skipped: false,
      resetApplied: Boolean(synced.resetApplied),
      shiprocketPickupId: pickupId,
      message: pickupId
        ? `Synced from Shiprocket (${pickupId}).`
        : synced.resetApplied
          ? 'Shiprocket reset detected — use Ship now to re-book.'
          : 'Synced from Shiprocket.'
    };
  } catch (err) {
    logger.error('runBulkSyncShiprocketSingle', { orderId, message: err?.message, stack: err?.stack });
    return {
      orderId: String(orderId || '').trim() || String(orderId),
      success: false,
      skipped: false,
      code: 'UNHANDLED',
      message: err?.message || String(err)
    };
  }
}

/** POST /orders/admin/items/bulk-fulfillment/sync-shiprocket  body: { orderIds: string[], concurrency?: number } */
exports.adminBulkFulfillmentSyncShiprocket = async (req, res) => {
  try {
    if (!assertStaffJson(req, res)) return;
    const orderIds = normalizeBulkOrderIds(req.body);
    if (orderIds.length === 0) {
      return jsonError(res, 400, 'ORDER_IDS_REQUIRED', `Provide orderIds (non-empty array, max ${MAX_BULK_ORDER_IDS}).`);
    }

    const parallel = parseBulkConcurrency(req.body?.concurrency);
    const scopeMatch = getAdminOrderMatch(req);
    const results = await mapInConcurrentWindows(orderIds, parallel, (oid) =>
      runBulkSyncShiprocketSingle(oid, scopeMatch)
    );

    const succeeded = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);
    const skipped = results.filter((r) => r.skipped);

    return res.json({
      success: true,
      summary: {
        total: results.length,
        succeeded: succeeded.length,
        failed: failed.length,
        skipped: skipped.length,
        completed: succeeded.filter((r) => !r.skipped).length,
        pickupIdsSaved: succeeded.filter((r) => r.shiprocketPickupId).length
      },
      results
    });
  } catch (error) {
    logger.error('adminBulkFulfillmentSyncShiprocket', { message: error.message, stack: error.stack });
    return jsonError(res, 500, 'BULK_SYNC_SHIPROCKET_FAILED', error.message || 'Server error');
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

/** POST /orders/admin/items/:orderId/fulfillment/assign-ship  body: { courierId?: number, confirmSubstitute?: boolean } */
exports.adminFulfillmentAssignShip = async (req, res) => {
  try {
    const order = await loadStaffOrder(req, res, req.params.orderId);
    if (!order) return;
    if (!requireFulfillmentPaymentReady(order, res)) return;
    if (!requireShipmentOpsAction(order, 'shipNow', res)) return;
    const courierId = req.body?.courierId != null ? Number(req.body.courierId) : null;
    const confirmSubstitute = Boolean(req.body?.confirmSubstitute);
    const assignRes = await runAssignShipFromOrder(order, courierId, { confirmSubstitute });
    if (!assignRes.success) {
      const c = assignRes.code || 'ASSIGN_AWB_FAILED';
      let status = 502;
      if (
        [
          'SHIPMENT_ID_MISSING',
          'INVALID_DELIVERY_PINCODE',
          'INVALID_COURIER_ID',
          'COURIER_ID_REQUIRED',
          'NO_QUOTED_COURIER'
        ].includes(c)
      ) {
        status = 400;
      } else if (c === 'AWB_ALREADY_ASSIGNED') {
        status = 409;
      } else if (c === 'ASSIGN_INTERNAL_ERROR') {
        status = 500;
      } else if (c === 'SHIPROCKET_WALLET_OR_BALANCE') {
        status = 402;
      } else if (c === 'QUOTED_COURIER_UNAVAILABLE') {
        status = 409;
      }
      return jsonError(res, status, c, assignRes.message, {
        details: assignRes.details || null,
        quotedCourier: assignRes.quotedCourier || null,
        suggestedCourier: assignRes.suggestedCourier || null,
        availableCouriers: assignRes.availableCouriers || null,
        quotedFreightInr: assignRes.quotedFreightInr ?? null,
        customerBillUnchanged: assignRes.customerBillUnchanged !== false
      });
    }
    return res.json({
      success: true,
      message: assignRes.message,
      courierId: assignRes.courierId,
      shipment: assignRes.shipment,
      order: assignRes.order,
      provider: assignRes.provider || resolveOrderShippingProvider(order),
      substituted: Boolean(assignRes.substituted || assignRes.courierSubstituted),
      pendingAwb: Boolean(assignRes.pendingAwb),
      customerBillUnchanged: assignRes.customerBillUnchanged !== false
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

    if (isShipmozoOrder(order)) {
      // On-demand Case-1 RTO-aware reconcile — never call Shiprocket
      const awb = order.shipmentInfo?.awbCode || order.shipmentInfo?.trackingNumber;
      if (!awb) {
        return jsonError(
          res,
          400,
          'SHIPMOZO_AWB_MISSING',
          'No AWB on this Shipmozo order yet. Use Track after AWB is assigned.'
        );
      }
      const { reconcileOrderFromShipmozo } = require('../services/shipmozoReconcile.service');
      const reconcileResult = await reconcileOrderFromShipmozo(order, {
        source: 'admin_manual_sync_shipmozo',
        allowOrderStatusUpdate: true,
        notify: true
      });
      if (!reconcileResult.success) {
        return jsonError(
          res,
          502,
          reconcileResult.code || 'SHIPMOZO_TRACK_FAILED',
          reconcileResult.message || 'Track failed'
        );
      }
      let freshOrder = reconcileResult.order || (await Order.findOne({ orderId: order.orderId }));

      let oosShippingSettlement = { settled: false, skipped: true, reason: 'not_run' };
      try {
        if (freshOrder?.paymentInfo?.oosShippingSettlement?.pending === true) {
          oosShippingSettlement = await trySettlePendingOosOrder(freshOrder, {
            source: 'admin_manual_sync_shipmozo'
          });
          if (oosShippingSettlement.settled) {
            const afterSettle = await Order.findOne({ orderId: order.orderId });
            if (afterSettle) {
              await evaluateAndPersistShipmentOps(afterSettle, { source: 'oos_shipping_settled_sync' });
            }
          }
        }
      } catch (settleErr) {
        logger.error('oos shipping settlement after Shipmozo sync failed', {
          orderId: order?.orderId,
          message: settleErr?.message || String(settleErr)
        });
        oosShippingSettlement = {
          settled: false,
          skipped: false,
          reason: 'settlement_error',
          message: settleErr?.message || String(settleErr)
        };
      }

      freshOrder = (await Order.findOne({ orderId: order.orderId })) || freshOrder;
      return res.json({
        success: true,
        message: 'Shipmozo tracking refreshed for this order.',
        order: freshOrder,
        provider: SHIPPING_PROVIDERS.SHIPMOZO,
        tracking: reconcileResult.tracking || null,
        warehouseDelivered: Boolean(reconcileResult.warehouseDelivered),
        oosShippingSettlement
      });
    }

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
    if (!synced.resetApplied) {
      await ensureShiprocketPickupId(order.orderId, 'admin_manual_sync_pickup_id');
    }
    const freshOrder = (await Order.findOne({ orderId: order.orderId })) || repaired;

    let oosShippingSettlement = { settled: false, skipped: true, reason: 'not_run' };
    if (freshOrder?.paymentInfo?.oosShippingSettlement?.pending === true) {
      oosShippingSettlement = await trySettlePendingOosOrder(freshOrder, {
        source: 'admin_manual_sync'
      });
      if (oosShippingSettlement.settled) {
        const afterSettle = await Order.findOne({ orderId: order.orderId });
        if (afterSettle) {
          await evaluateAndPersistShipmentOps(afterSettle, { source: 'oos_shipping_settled_sync' });
        }
      }
    }

    const finalOrder =
      (await Order.findOne({ orderId: order.orderId })) || freshOrder;
    const si = finalOrder?.shipmentInfo || {};
    const shipmentOps = buildShipmentOpsView(finalOrder, { source: 'admin_manual_sync' });
    const pickupMsg = synced.resetApplied
      ? 'Shiprocket reset detected — stale AWB/pickup cleared. Use Ship now to re-book.'
      : si.shiprocketPickupId
        ? `Synced from Shiprocket. Pickup ID: ${si.shiprocketPickupId}.`
        : si.pickupDate
          ? `Courier pickup day updated to ${si.pickupDate} (from Shiprocket).`
          : 'Synced from Shiprocket. Confirm pickup day on Shiprocket if needed, then refresh again.';
    return res.json({
      success: true,
      synced: synced.success,
      message: synced.success ? pickupMsg : synced.message || 'Sync completed with warnings.',
      pickupDate: si.pickupDate || null,
      shiprocketPickupId: si.shiprocketPickupId || null,
      pickupDateSource: synced.pickupDateSource || null,
      oosShippingSettlement,
      shipmentOps,
      order: finalOrder
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

    if (isShipmozoOrder(order)) {
      if (!requireShipmentOpsAction(order, 'schedulePickup', res)) return;
      const smOid =
        order.shipmentInfo?.shipmozoOrderId || order.shipmentInfo?.shipmentId || order.orderId;
      const pickup = await ShipmozoService.schedulePickup({ orderId: smOid });
      if (!pickup.success) {
        return jsonError(
          res,
          502,
          pickup.code || 'SCHEDULE_PICKUP_FAILED',
          pickup.message || 'Shipmozo schedule-pickup failed',
          { details: pickup.raw || null }
        );
      }
      await applyUpsertShipmentInfo({
        order,
        shipmentPayload: {
          awbCode: pickup.awbCode || order.shipmentInfo?.awbCode,
          trackingNumber: pickup.trackingNumber || pickup.awbCode || order.shipmentInfo?.trackingNumber,
          courier: pickup.courier || order.shipmentInfo?.courier,
          pickupScheduledAt: new Date(),
          pickupDate: new Date().toISOString().slice(0, 10),
          shipmozoNeedsManualPickup: false,
          providerStatus: 'PICKUP_SCHEDULED',
          provider: SHIPPING_PROVIDERS.SHIPMOZO
        },
        trigger: 'admin_schedule_pickup_shipmozo',
        allowOrderStatusUpdate: Boolean(pickup.awbCode)
      });
      const fresh = await Order.findOne({ orderId: order.orderId });
      return res.json({
        success: true,
        message: 'Pickup scheduled on Shipmozo.',
        order: fresh,
        provider: SHIPPING_PROVIDERS.SHIPMOZO,
        shipment: pickup
      });
    }

    const shipmentId = order.shipmentInfo?.shipmentId;
    if (!shipmentId) {
      return jsonError(res, 400, 'SHIPMENT_ID_MISSING', 'No shipment_id on order.');
    }
    if (!(order.shipmentInfo?.awbCode || order.shipmentInfo?.trackingNumber)) {
      return jsonError(res, 400, 'AWB_REQUIRED', 'Assign AWB (ship) before scheduling pickup.');
    }
    if (!requireShipmentOpsAction(order, 'schedulePickup', res)) return;

    const pickupDate = String(req.body?.pickupDate || '').trim();
    const dateCheck = pickupDateNotInPast(pickupDate);
    if (!dateCheck.ok) {
      return jsonError(res, 400, 'INVALID_PICKUP_DATE', dateCheck.message);
    }

    const pickupPrep = await ensureForwardPickupStateForSchedule(order, 'admin_schedule_pickup_prep');
    let workingOrder = (await Order.findOne({ orderId: order.orderId })) || order;
    const prepOps = buildShipmentOpsView(workingOrder, { source: 'admin_schedule_pickup_prep' });

    if (pickupPrep.booked && !prepOps.actionCapabilities?.schedulePickup) {
      const savedDate = pickupPrep.pickupDate || workingOrder?.shipmentInfo?.pickupDate || null;
      const sameDate = savedDate && pickupDate && savedDate === pickupDate;
      return res.json({
        success: true,
        alreadyScheduled: true,
        message: savedDate
          ? sameDate
            ? `Pickup is already scheduled on Shiprocket (${savedDate}).`
            : `Pickup is already scheduled on Shiprocket (${savedDate}). You selected ${pickupDate}.`
          : 'Pickup is already scheduled on Shiprocket.',
        pickupDate: savedDate,
        requestedPickupDate: pickupDate,
        shipmentOps: buildShipmentOpsView(workingOrder, { source: 'admin_schedule_pickup_prep' }),
        order: workingOrder
      });
    }

    const srDateCheck = await ShiprocketService.validatePickupDateForSchedule(pickupDate);
    if (!srDateCheck.ok) {
      return jsonError(res, 400, srDateCheck.code || 'PICKUP_DATE_NOT_ALLOWED', srDateCheck.message);
    }

    const sched = await ShiprocketService.schedulePickup({
      shipmentId: workingOrder.shipmentInfo?.shipmentId || shipmentId,
      pickupDate: srDateCheck.date
    });
    const outcome = await applyPickupScheduleOutcome(workingOrder, {
      sched,
      requestedPickupDate: srDateCheck.date,
      trigger: 'admin_schedule_pickup'
    });

    if (!outcome.success) {
      return jsonError(res, 502, outcome.code || 'PICKUP_FAILED', outcome.message || 'Pickup schedule failed', {
        details: outcome.details || null,
        stalePickupCleared: Boolean(outcome.stalePickupCleared)
      });
    }

    await evaluateAndPersistShipmentOps(
      (await Order.findOne({ orderId: order.orderId })) || workingOrder,
      { source: 'admin_schedule_pickup' }
    );
    await syncShipmentFromShiprocket(order, 'admin_schedule_pickup_post');
    const freshWithOps = await Order.findOne({ orderId: order.orderId });
    return res.json({
      success: true,
      message: outcome.message || 'Pickup scheduled',
      pickupDate: outcome.pickupDate || freshWithOps?.shipmentInfo?.pickupDate || null,
      pickupDateSource: outcome.pickupDateSource || null,
      requestedPickupDate: outcome.requestedPickupDate || srDateCheck.date,
      dateAdjusted: Boolean(outcome.dateAdjusted),
      alreadyScheduled: Boolean(outcome.alreadyScheduled),
      shipmentOps: buildShipmentOpsView(freshWithOps, { source: 'admin_schedule_pickup' }),
      order: freshWithOps,
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
      return jsonError(res, 400, 'AWB_REQUIRED', 'Assign AWB before requesting a shipping label.');
    }

    // Shipmozo: never persist label bytes — return a file URL that proxies live fetch.
    if (isShipmozoOrder(order)) {
      const awb = String(order.shipmentInfo.awbCode || order.shipmentInfo.trackingNumber).trim();
      const label = await ShipmozoService.getOrderLabel(awb);
      if (!label.success || !label.labelUrl) {
        return jsonError(res, 502, 'LABEL_FAILED', label.message || 'Shipmozo label fetch failed', {
          details: label.raw || null
        });
      }
      await applyUpsertShipmentInfo({
        order,
        shipmentPayload: {
          // Clear any previously stored base64 blob; mark availability via labelDownloaded.
          labelUrl: null,
          labelDownloaded: true,
          fulfillmentLabelAwb: awb,
          provider: SHIPPING_PROVIDERS.SHIPMOZO,
          providerStatus: order.shipmentInfo?.providerStatus
        },
        trigger: 'admin_shipping_label_shipmozo',
        allowOrderStatusUpdate: false
      });
      const fresh = await Order.findOne({ orderId: order.orderId });
      // Client should use shipping-label-file for open/download (correct MIME). Keep labelUrl out of JSON.
      return res.json({
        success: true,
        labelFilePath: `/orders/admin/items/${encodeURIComponent(String(order.orderId))}/fulfillment/shipping-label-file`,
        order: fresh,
        provider: SHIPPING_PROVIDERS.SHIPMOZO
      });
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
    const label = await resolveLabelUrlForOrder(order);
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
 * Proxies provider label file (Shiprocket PDF; Shipmozo PNG/JPEG/PDF) for admin download/open without CORS issues.
 */
exports.adminFulfillmentShippingLabelFile = async (req, res) => {
  try {
    const order = await loadStaffOrder(req, res, req.params.orderId);
    if (!order) return;
    if (!requireFulfillmentPaymentReady(order, res)) return;
    if (!requireShipmentOpsAction(order, 'downloadLabel', res)) return;

    const isShipmozo = isShipmozoOrder(order);
    let buf;
    let contentType = 'application/pdf';
    let extension = 'pdf';
    try {
      if (isShipmozo) {
        const file = await fetchShipmozoLabelFile(order);
        buf = file.buffer;
        contentType = file.contentType || 'image/png';
        extension = file.extension || 'png';
        // Never claim PDF when payload is an image (Shipmozo default is PNG).
        if (contentType === 'application/octet-stream' || extension === 'bin') {
          const sniffed = resolveLabelFileMeta(buf, '');
          contentType = sniffed.contentType;
          extension = sniffed.extension;
          if (extension === 'bin') {
            contentType = 'image/png';
            extension = 'png';
          }
        }
      } else {
        buf = await fetchShiprocketLabelPdfBuffer(order);
        contentType = 'application/pdf';
        extension = 'pdf';
      }
      const awb = String(order.shipmentInfo?.awbCode || order.shipmentInfo?.trackingNumber || '').trim();
      await applyUpsertShipmentInfo({
        order,
        shipmentPayload: {
          labelDownloaded: true,
          ...(awb ? { fulfillmentLabelAwb: awb } : {}),
          ...(isShipmozo
            ? {
                provider: SHIPPING_PROVIDERS.SHIPMOZO,
                // Never keep Shipmozo base64 labels in Mongo — fetch live on each download.
                labelUrl: null
              }
            : {})
        },
        trigger: isShipmozo ? 'admin_label_downloaded_shipmozo' : 'admin_label_downloaded',
        allowOrderStatusUpdate: false
      });
      await evaluateAndPersistShipmentOps(order, {
        source: isShipmozo ? 'admin_label_downloaded_shipmozo' : 'admin_label_downloaded'
      });
    } catch (fetchErr) {
      logger.error('adminFulfillmentShippingLabelFile fetch', {
        message: fetchErr.message,
        stack: fetchErr.stack,
        code: fetchErr.code,
        status: fetchErr.response?.status,
        provider: isShipmozo ? 'shipmozo' : 'shiprocket'
      });
      const code = fetchErr.code || 'LABEL_FILE_FAILED';
      if (code === 'SHIPROCKET_ORDER_ID_MISSING') {
        return jsonError(
          res,
          400,
          code,
          isShipmozo
            ? 'Shipmozo label is not available yet. Use Ship now / Refresh, then try label again.'
            : fetchErr.message || 'No Shiprocket order id on order.'
        );
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
          `Could not download label from ${isShipmozo ? 'Shipmozo' : 'Shiprocket'} (HTTP ${fetchErr.response.status}).`
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
    const filePrefix = isShipmozo ? 'Shipmozo-label' : 'Shiprocket-label';
    const filename = `${filePrefix}-${safe}.${extension}`;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    // Let browsers/axios read filename + type (fixes save-as .pdf while body is PNG).
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Type');
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

    if (order.orderStatus === 'shipped' || order.orderStatus === 'out_for_delivery' || order.orderStatus === 'delivered') {
      return jsonError(res, 409, 'ORDER_TOO_FAR', 'Cannot cancel shipment at this order stage.');
    }

    // Shipmozo cancel
    if (isShipmozoOrder(order)) {
      const awb = order.shipmentInfo?.awbCode || order.shipmentInfo?.trackingNumber;
      const smOid = order.shipmentInfo?.shipmozoOrderId || order.shipmentInfo?.shipmentId || order.orderId;
      if (!awb) {
        return jsonError(res, 400, 'AWB_REQUIRED', 'AWB required to cancel on Shipmozo.');
      }
      const cancel = await ShipmozoService.cancelOrder({ orderId: smOid, awbNumber: awb });
      if (!cancel.success) {
        return jsonError(res, 502, cancel.code || 'CANCEL_FAILED', cancel.message || 'Shipmozo cancel failed', {
          details: cancel.raw || null
        });
      }
      const fresh = await finalizeShipmentAfterRemoteCancel(order);
      const ops = fresh ? buildShipmentOpsView(fresh, { source: 'admin_cancel_shipment_shipmozo' }) : null;
      return res.json({
        success: true,
        message:
          'Shipment cancelled on Shipmozo. Stale AWB data cleared — use Ship now to book again if needed.',
        raw: cancel.raw || null,
        order: fresh,
        shipmentOps: ops,
        readyForReship: Boolean(ops?.actionCapabilities?.shipNow),
        provider: SHIPPING_PROVIDERS.SHIPMOZO
      });
    }

    const srOid = order.shipmentInfo?.shiprocketOrderId;
    if (!srOid) {
      return jsonError(res, 400, 'SHIPROCKET_ORDER_ID_MISSING', 'No Shiprocket order id stored; cannot cancel remotely.');
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

function shouldSkipBulkDocForOrder(order) {
  const st = String(order?.orderStatus || '').toLowerCase();
  if (st === 'rto') return true;
  return isUnpaidTerminalOrder(order);
}

/** POST /orders/admin/items/bulk-documents/tax-invoices-zip — ZIP of GST invoice HTML + manifest.json */
exports.adminBulkTaxInvoicesZip = async (req, res) => {
  try {
    if (!assertStaffJson(req, res)) return;
    const orderIds = normalizeBulkOrderIds(req.body);
    if (orderIds.length === 0) {
      return jsonError(res, 400, 'ORDER_IDS_REQUIRED', `Provide orderIds (non-empty array, max ${MAX_BULK_ORDER_IDS}).`);
    }
    const parallel = parseBulkConcurrency(req.body?.concurrency);
    const scopeMatch = getAdminOrderMatch(req);

    const results = await mapInConcurrentWindows(orderIds, parallel, async (oid) => {
      try {
        const order = await loadOrderDocByOrderId(oid, scopeMatch);
        if (!order) {
          return { orderId: oid, success: false, code: 'ORDER_NOT_FOUND', message: 'Order not found' };
        }
        if (shouldSkipBulkDocForOrder(order)) {
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
    const scopeMatch = getAdminOrderMatch(req);

    const results = await mapInConcurrentWindows(orderIds, parallel, async (oid) => {
      try {
        const order = await loadOrderDocByOrderId(oid, scopeMatch);
        if (!order) {
          return { orderId: oid, success: false, code: 'ORDER_NOT_FOUND', message: 'Order not found' };
        }
        if (shouldSkipBulkDocForOrder(order)) {
          return {
            orderId: oid,
            success: false,
            code: 'SKIP_BAD_STATUS',
            message: `Cannot download manifest for status ${order.orderStatus}`
          };
        }
        const pdfBuf = await fetchShiprocketManifestPdfBuffer(order);
        await applyUpsertShipmentInfo({
          order,
          shipmentPayload: { manifestDownloaded: true },
          trigger: 'admin_bulk_manifest_downloaded',
          allowOrderStatusUpdate: false
        });
        await evaluateAndPersistShipmentOps(order, { source: 'admin_bulk_manifest_downloaded' });
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
    const scopeMatch = getAdminOrderMatch(req);

    const results = await mapInConcurrentWindows(orderIds, parallel, async (oid) => {
      try {
        const order = await loadOrderDocByOrderId(oid, scopeMatch);
        if (!order) {
          return { orderId: oid, success: false, code: 'ORDER_NOT_FOUND', message: 'Order not found' };
        }
        if (shouldSkipBulkDocForOrder(order)) {
          return {
            orderId: oid,
            success: false,
            code: 'SKIP_BAD_STATUS',
            message: `Cannot download label for status ${order.orderStatus}`
          };
        }
        let fileBuf;
        let ext = 'pdf';
        if (isShipmozoOrder(order)) {
          const file = await fetchShipmozoLabelFile(order);
          fileBuf = file.buffer;
          ext = file.extension && file.extension !== 'bin' ? file.extension : 'png';
        } else {
          fileBuf = await fetchShiprocketLabelPdfBuffer(order);
          ext = 'pdf';
        }
        await applyUpsertShipmentInfo({
          order,
          shipmentPayload: { labelDownloaded: true },
          trigger: 'admin_bulk_label_downloaded',
          allowOrderStatusUpdate: false
        });
        await evaluateAndPersistShipmentOps(order, { source: 'admin_bulk_label_downloaded' });
        const entryName = safeZipEntryBase(oid, `-shipping-label.${ext}`);
        return { orderId: oid, success: true, entryName, pdfBuf: fileBuf };
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
    if (!isCustomerProductReturnRequest(order)) {
      return jsonError(
        res,
        404,
        'RETURN_REQUEST_NOT_FOUND',
        'No customer product return request found for this order'
      );
    }
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
      order.returnInfo = mergeReturnInfo(order.returnInfo, {
        reverseLastError: String(reverse?.error || 'Could not initiate reverse pickup')
      });
      order.markModified('returnInfo');
      await order.save();
      return jsonError(res, 502, 'REVERSE_PICKUP_CREATE_FAILED', 'Reverse pickup initiation failed', {
        details: reverse?.error || null
      });
    }
    order.returnInfo = mergeReturnInfo(order.returnInfo, {
      status: 'approved',
      reverseShipmentId: reverse.reverseShipmentId || order.returnInfo?.reverseShipmentId || null,
      reverseAwbCode: reverse.reverseAwbCode || order.returnInfo?.reverseAwbCode || null,
      reverseTrackingNumber: reverse.reverseTrackingNumber || order.returnInfo?.reverseTrackingNumber || null,
      reverseCourier: reverse.reverseCourier || order.returnInfo?.reverseCourier || null,
      reverseProviderStatus: reverse.providerStatus || 'reverse_pickup_created',
      reverseLastSyncAt: new Date(),
      reverseLastError: null
    });
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

    const resolved = await resolveManifestUrlForOrder(order);
    if (!resolved.success || !resolved.manifestUrl) {
      return jsonError(res, 502, resolved.code || 'MANIFEST_RESOLVE_FAILED', resolved.message, {
        details: resolved.details || null
      });
    }

    const manifestUrl = String(resolved.manifestUrl).trim();
    const shiprocketOrderId = resolved.shiprocketOrderId || (await resolveShiprocketOrderIdForOrder(order));

    await applyUpsertShipmentInfo({
      order,
      shipmentPayload: {
        manifestUrl,
        manifestGeneratedAt: new Date(),
        shiprocketOrderId: shiprocketOrderId || undefined
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
      await applyUpsertShipmentInfo({
        order,
        shipmentPayload: { manifestDownloaded: true },
        trigger: 'admin_manifest_downloaded',
        allowOrderStatusUpdate: false
      });
      await evaluateAndPersistShipmentOps(order, { source: 'admin_manifest_downloaded' });
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
    const scopeMatch = getAdminOrderMatch(req);
    const results = await mapInConcurrentWindows(orderIds, parallel, (oid) =>
      runAdminApproveOrderSingle(oid, { scopeMatch })
    );

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
    const scopeMatch = getAdminOrderMatch(req);
    const results = await mapInConcurrentWindows(orderIds, parallel, (oid) =>
      runAdminCancelOrderSingle(oid, { scopeMatch })
    );

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
