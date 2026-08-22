/**
 * Shipmozo panel parity sync — pull AWB / courier / status from Shipmozo when
 * assignment happened on their panel (Ship Now failed or manual override).
 *
 * Production notes:
 * - Tries marketplace + channel order ids for get-order-detail
 * - Deep-scans API payloads for AWB/courier fields
 * - schedule-pickup fallback when panel shows booked but AWB missing in detail
 * - Never clears existing AWB; merge-only upserts
 */
const Order = require('../models/Order');
const ShipmozoService = require('../utils/shipmozo');
const logger = require('../utils/logger');
const { SHIPPING_PROVIDERS, isShipmozoOrder } = require('../constants/shippingProviders');
const { reconcileOrderFromShipmozo } = require('./shipmozoReconcile.service');

const AWB_STRING_KEYS = [
  'awb_number',
  'awbNumber',
  'awb',
  'awb_no',
  'awbNo',
  'lr_number',
  'lrNumber',
  'lr_no',
  'tracking_number',
  'trackingNumber',
  'tracking_no',
  'waybill',
  'waybill_number',
  'waybillNumber',
  'airwaybill',
  'airway_bill',
  'airway_bill_number'
];

const COURIER_STRING_KEYS = [
  'courier',
  'courier_name',
  'courierName',
  'courier_company',
  'courier_company_name',
  'courierCompany',
  'assigned_courier',
  'assignedCourier',
  'shipping_partner',
  'shippingPartner'
];

const STATUS_STRING_KEYS = [
  'order_status',
  'orderStatus',
  'status',
  'current_status',
  'currentStatus',
  'shipment_status',
  'shipmentStatus',
  'provider_status',
  'providerStatus'
];

const PANEL_BOOKED_STATUS_RE =
  /\bscheduled\b|\bschedule\b|courier\s*assigned|data\s*received|pickup\s*scheduled|pickup\s*generated|pickup\s*done|out\s*for\s*pickup|\bofp\b|manifest|picked|\bbooked\b|ready\s*to\s*ship|in\s*transit|\bshipped\b|out\s*for\s*delivery|\bdelivered\b/i;

/**
 * @param {object | null | undefined} shipmentInfo
 */
function resolveShipmozoMarketplaceOrderId(shipmentInfo) {
  const si = shipmentInfo || {};
  const id = String(si.shipmozoOrderId || si.shipmentId || si.shipmozoReferenceId || '').trim();
  return id || null;
}

/**
 * Marketplace id(s) + channel orderId (push-order sends order.orderId as order_id).
 * @param {import('mongoose').Document|object} order
 */
function resolveShipmozoDetailOrderIds(order) {
  const si = order?.shipmentInfo || {};
  const ids = [];
  const add = (v) => {
    const s = String(v || '').trim();
    if (s && !ids.includes(s)) ids.push(s);
  };
  add(si.shipmozoOrderId);
  add(si.shipmentId);
  add(si.shipmozoReferenceId);
  add(order?.orderId);
  return ids;
}

/**
 * @param {object | null | undefined} row
 * @param {string[]} keys
 */
function pickFirstString(row, keys) {
  if (!row || typeof row !== 'object') return null;
  for (const key of keys) {
    const v = row[key];
    if (v == null || v === '') continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return null;
}

/**
 * @param {object | null | undefined} row
 * @param {string[]} keys
 */
function pickFirstCourierId(row, keys) {
  if (!row || typeof row !== 'object') return null;
  for (const key of keys) {
    const v = row[key];
    if (v == null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return String(Math.trunc(n));
  }
  return null;
}

/**
 * @param {unknown} value
 */
function normalizeAwbCandidate(value) {
  if (value == null || value === '') return null;
  const s = String(value).replace(/\s+/g, '').trim();
  if (!s) return null;
  if (/^(null|undefined|na|n\/a|0)$/i.test(s)) return null;
  if (s.length < 6) return null;
  return s;
}

/**
 * Deep search for AWB in arbitrary Shipmozo JSON (depth-limited).
 * @param {unknown} node
 * @param {number} depth
 */
function deepFindAwb(node, depth = 0) {
  if (node == null || depth > 8) return null;
  if (typeof node === 'string' || typeof node === 'number') {
    return normalizeAwbCandidate(node);
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = deepFindAwb(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof node !== 'object') return null;

  for (const key of AWB_STRING_KEYS) {
    if (Object.prototype.hasOwnProperty.call(node, key)) {
      const found = normalizeAwbCandidate(node[key]);
      if (found) return found;
    }
  }

  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') {
      const found = deepFindAwb(value, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * @param {object|null} a
 * @param {object|null} b
 */
function mergeParsedDetail(a, b) {
  if (!a) return b || {};
  if (!b) return a || {};
  return {
    awbCode: a.awbCode || b.awbCode || null,
    courier: a.courier || b.courier || null,
    assignedCourierId: a.assignedCourierId || b.assignedCourierId || null,
    providerStatus: a.providerStatus || b.providerStatus || null,
    pickupDate: a.pickupDate || b.pickupDate || null
  };
}

/**
 * Normalize Shipmozo get-order-detail payload (field names vary by API version).
 * @param {unknown} raw
 */
function parseShipmozoOrderDetail(raw) {
  let row = raw;
  if (raw && typeof raw === 'object' && raw.data != null && !raw.awb_number && !raw.awb) {
    row = raw.data;
  }
  if (Array.isArray(row)) row = row[0] || {};
  if (!row || typeof row !== 'object') row = {};

  const nestedCandidates = [
    row.shipment,
    row.order,
    row.order_detail,
    row.orderDetail,
    row.shipment_detail,
    row.shipmentDetail,
    row.details,
    row.result
  ].filter((x) => x && typeof x === 'object');

  const sources = [row, ...nestedCandidates];

  let awbCode = null;
  let courier = null;
  let assignedCourierId = null;
  let providerStatus = null;
  let pickupDate = null;

  for (const src of sources) {
    awbCode =
      awbCode ||
      normalizeAwbCandidate(pickFirstString(src, AWB_STRING_KEYS)) ||
      deepFindAwb(src);
    courier = courier || pickFirstString(src, COURIER_STRING_KEYS);
    assignedCourierId =
      assignedCourierId ||
      pickFirstCourierId(src, [
        'courier_id',
        'courierId',
        'assigned_courier_id',
        'courier_company_id',
        'shipping_partner_id'
      ]);
    providerStatus = providerStatus || pickFirstString(src, STATUS_STRING_KEYS);
    pickupDate =
      pickupDate ||
      pickFirstString(src, ['pickup_date', 'pickupDate', 'scheduled_pickup_date', 'pickup_scheduled_date']);
  }

  if (!awbCode) {
    awbCode = deepFindAwb(row);
  }

  return {
    awbCode,
    courier,
    assignedCourierId,
    providerStatus,
    pickupDate
  };
}

/**
 * @param {string|null|undefined} status
 */
function isShipmozoPanelBookedStatus(status) {
  const s = String(status || '').trim();
  if (!s) return false;
  if (/^pushed$/i.test(s)) return false;
  return PANEL_BOOKED_STATUS_RE.test(s);
}

/**
 * Panel assignment detected (courier booked on Shipmozo even if AWB not in our DB yet).
 * @param {object|null|undefined} shipmentInfo
 */
function isShipmozoPanelBooked(shipmentInfo) {
  const si = shipmentInfo || {};
  if (isShipmozoPanelBookedStatus(si.providerStatus)) return true;
  if (si.pickupScheduledAt || si.pickupDate) return true;
  const courier = String(si.courier || '').trim();
  if (courier && !/^pending\s*assignment$/i.test(courier)) return true;
  if (si.assignedCourierId && String(si.assignedCourierId).trim()) return true;
  return false;
}

/**
 * @param {string[]} orderIds
 */
async function fetchMergedShipmozoOrderDetail(orderIds) {
  let merged = null;
  let lastError = null;

  for (const detailOrderId of orderIds) {
    try {
      const detailRes = await ShipmozoService.getOrderDetail(detailOrderId);
      if (!detailRes?.success) {
        lastError = detailRes?.message || 'Shipmozo order detail failed';
        continue;
      }
      const parsed = parseShipmozoOrderDetail(detailRes.data);
      merged = {
        parsed: mergeParsedDetail(merged?.parsed, parsed),
        detailOrderId,
        raw: detailRes.data
      };
      if (merged.parsed.awbCode) break;
    } catch (err) {
      lastError = err?.message || String(err);
      logger.warn('[shipmozoPanelSync] getOrderDetail attempt failed', {
        detailOrderId,
        message: lastError
      });
    }
  }

  return { merged, lastError };
}

/**
 * schedule-pickup often returns AWB after panel-side assign (idempotent read-back).
 * @param {string[]} orderIds
 */
async function tryResolveAwbViaSchedulePickup(orderIds) {
  for (const orderId of orderIds) {
    try {
      const pickup = await ShipmozoService.schedulePickup({ orderId });
      const awb = normalizeAwbCandidate(pickup?.awbCode || pickup?.trackingNumber);
      if (pickup?.success && awb) {
        return {
          awbCode: awb,
          trackingNumber: awb,
          courier: pickup.courier || null,
          scheduleOrderId: orderId,
          raw: pickup.raw || null
        };
      }
    } catch (err) {
      logger.debug('[shipmozoPanelSync] schedule-pickup AWB fallback failed', {
        orderId,
        message: err?.message || String(err)
      });
    }
  }
  return null;
}

/**
 * @param {string} awb
 */
async function probeShipmozoLabelReady(awb) {
  const code = String(awb || '').trim();
  if (!code) return false;
  try {
    const res = await ShipmozoService.getOrderLabel(code);
    return Boolean(res?.success && res?.labelUrl);
  } catch (err) {
    logger.debug('[shipmozoPanelSync] label probe failed', {
      awb: code,
      message: err?.message || String(err)
    });
    return false;
  }
}

/**
 * @param {import('mongoose').Document|object} order
 * @param {{ hadLocalAwb?: boolean, panelBooked?: boolean }} ctx
 */
async function promoteProcessingAfterPanelSync(order, ctx = {}) {
  let fresh = order;
  if (!fresh?.orderId) return fresh;

  const gotAwb = Boolean(
    String(fresh.shipmentInfo?.awbCode || fresh.shipmentInfo?.trackingNumber || '').trim()
  );
  const panelBooked = ctx.panelBooked === true || isShipmozoPanelBooked(fresh.shipmentInfo);
  const st = String(fresh.orderStatus || '').toLowerCase();

  if (['pending', 'confirmed'].includes(st) && (gotAwb || panelBooked)) {
    fresh.orderStatus = 'processing';
    fresh.markModified('orderStatus');
    try {
      await fresh.save();
      fresh = (await Order.findOne({ orderId: fresh.orderId })) || fresh;
    } catch (saveErr) {
      logger.warn('[shipmozoPanelSync] confirmed→processing promote failed', {
        orderId: fresh.orderId,
        message: saveErr?.message || String(saveErr)
      });
    }
  }

  return fresh;
}

/**
 * Pull assignment state from Shipmozo panel into Mongo (no tracking reconcile).
 * @param {import('mongoose').Document|object} order
 * @param {{ source?: string, probeLabel?: boolean, force?: boolean }} [opts]
 */
async function hydrateOrderFromShipmozoPanel(order, opts = {}) {
  const source = String(opts.source || 'shipmozo_panel_hydrate').trim() || 'shipmozo_panel_hydrate';

  if (!order?.orderId) {
    return { success: false, code: 'ORDER_REQUIRED', hydrated: false, message: 'Order is required' };
  }
  if (!isShipmozoOrder(order)) {
    return { success: false, code: 'NOT_SHIPMOZO_ORDER', hydrated: false, message: 'Not a Shipmozo order' };
  }

  const detailOrderIds = resolveShipmozoDetailOrderIds(order);
  if (!detailOrderIds.length) {
    return {
      success: false,
      code: 'SHIPMOZO_ORDER_ID_MISSING',
      hydrated: false,
      message: 'No Shipmozo order id on this order yet'
    };
  }

  const hadLocalAwb = Boolean(
    String(order.shipmentInfo?.awbCode || order.shipmentInfo?.trackingNumber || '').trim()
  );

  const { merged, lastError } = await fetchMergedShipmozoOrderDetail(detailOrderIds);
  let parsed = merged?.parsed || {
    awbCode: null,
    courier: null,
    assignedCourierId: null,
    providerStatus: null,
    pickupDate: null
  };

  let awbCode = parsed.awbCode ? String(parsed.awbCode).trim() : null;
  let scheduleFallback = null;

  const panelLikelyBooked =
    isShipmozoPanelBookedStatus(parsed.providerStatus) ||
    Boolean(parsed.courier || parsed.assignedCourierId || parsed.pickupDate);

  if (!awbCode && (panelLikelyBooked || !merged)) {
    scheduleFallback = await tryResolveAwbViaSchedulePickup(detailOrderIds);
    if (scheduleFallback?.awbCode) {
      awbCode = scheduleFallback.awbCode;
      parsed = mergeParsedDetail(parsed, {
        awbCode,
        courier: scheduleFallback.courier || parsed.courier,
        providerStatus: parsed.providerStatus || 'SCHEDULED',
        assignedCourierId: parsed.assignedCourierId,
        pickupDate: parsed.pickupDate
      });
    }
  }

  if (!merged && !scheduleFallback && !awbCode) {
    return {
      success: false,
      code: 'SHIPMOZO_DETAIL_FAILED',
      hydrated: false,
      message: lastError || 'Shipmozo order detail failed for all known order ids',
      detailOrderIds
    };
  }

  if (!awbCode && !parsed.courier && !parsed.providerStatus && !parsed.assignedCourierId) {
    return {
      success: true,
      hydrated: false,
      code: 'NO_PANEL_ASSIGNMENT_YET',
      message: 'Shipmozo has no AWB/courier on this order yet',
      order: await Order.findOne({ orderId: order.orderId }),
      detailOrderIds
    };
  }

  const shipmentPayload = {
    provider: SHIPPING_PROVIDERS.SHIPMOZO,
    shipmozoOrderId: order.shipmentInfo?.shipmozoOrderId || resolveShipmozoMarketplaceOrderId(order.shipmentInfo),
    shipmentId: order.shipmentInfo?.shipmentId || resolveShipmozoMarketplaceOrderId(order.shipmentInfo)
  };

  if (awbCode) {
    shipmentPayload.awbCode = awbCode;
    shipmentPayload.trackingNumber = awbCode;
  }
  if (parsed.courier) shipmentPayload.courier = parsed.courier;
  if (scheduleFallback?.courier && !shipmentPayload.courier) {
    shipmentPayload.courier = scheduleFallback.courier;
  }
  if (parsed.assignedCourierId) shipmentPayload.assignedCourierId = parsed.assignedCourierId;
  if (parsed.providerStatus) shipmentPayload.providerStatus = parsed.providerStatus;
  if (parsed.pickupDate) shipmentPayload.pickupDate = parsed.pickupDate;

  if (panelLikelyBooked || awbCode) {
    if (!shipmentPayload.pickupDate && !order.shipmentInfo?.pickupDate) {
      shipmentPayload.pickupDate = new Date().toISOString().slice(0, 10);
    }
    if (!order.shipmentInfo?.pickupScheduledAt) {
      shipmentPayload.pickupScheduledAt = new Date();
    }
    shipmentPayload.shipmozoNeedsManualPickup = false;
  }

  if (opts.probeLabel !== false && awbCode && !order.shipmentInfo?.labelDownloaded) {
    const labelReady = await probeShipmozoLabelReady(awbCode);
    if (labelReady) shipmentPayload.labelDownloaded = true;
  }

  try {
    const { applyUpsertShipmentInfo } = require('../controllers/order.controller');
    await applyUpsertShipmentInfo({
      order,
      shipmentPayload,
      trigger: source,
      allowOrderStatusUpdate: Boolean(awbCode || parsed.providerStatus)
    });
  } catch (upsertErr) {
    logger.error('[shipmozoPanelSync] upsert after panel hydrate failed', {
      orderId: order.orderId,
      message: upsertErr?.message || String(upsertErr)
    });
    return {
      success: false,
      code: 'HYDRATE_PERSIST_FAILED',
      hydrated: false,
      message: upsertErr?.message || 'Could not save Shipmozo panel state'
    };
  }

  let fresh = await Order.findOne({ orderId: order.orderId });
  if (!fresh) {
    return {
      success: false,
      code: 'ORDER_NOT_FOUND_AFTER_HYDRATE',
      hydrated: false,
      message: 'Order missing after hydrate'
    };
  }

  fresh = await promoteProcessingAfterPanelSync(fresh, {
    hadLocalAwb,
    panelBooked: panelLikelyBooked || Boolean(awbCode)
  });

  try {
    const { evaluateAndPersistShipmentOps } = require('./shipmentOps');
    await evaluateAndPersistShipmentOps(fresh, { source });
    fresh = (await Order.findOne({ orderId: order.orderId })) || fresh;
  } catch (_) {
    /* non-blocking */
  }

  const gotAwb = Boolean(
    String(fresh.shipmentInfo?.awbCode || fresh.shipmentInfo?.trackingNumber || '').trim()
  );

  return {
    success: true,
    hydrated: true,
    partial: !gotAwb && isShipmozoPanelBooked(fresh.shipmentInfo),
    awbCode: gotAwb ? String(fresh.shipmentInfo?.awbCode || fresh.shipmentInfo?.trackingNumber || '') : null,
    labelDownloaded: Boolean(fresh?.shipmentInfo?.labelDownloaded),
    parsed,
    scheduleFallbackUsed: Boolean(scheduleFallback?.awbCode),
    detailOrderIds,
    order: fresh
  };
}

/**
 * Full Shipmozo sync: panel hydrate → track reconcile → label probe.
 * @param {import('mongoose').Document|object} order
 * @param {{ source?: string, allowOrderStatusUpdate?: boolean, notify?: boolean, probeLabel?: boolean }} [options]
 */
async function syncShipmentFromShipmozo(order, options = {}) {
  const source = String(options.source || 'shipmozo_sync').trim() || 'shipmozo_sync';

  if (!order?.orderId) {
    return { success: false, code: 'ORDER_REQUIRED', message: 'Order is required' };
  }
  if (!isShipmozoOrder(order)) {
    return { success: false, code: 'NOT_SHIPMOZO_ORDER', message: 'Not a Shipmozo order' };
  }

  const smRef = resolveShipmozoMarketplaceOrderId(order.shipmentInfo) || String(order.orderId || '').trim();
  const localAwb = String(order.shipmentInfo?.awbCode || order.shipmentInfo?.trackingNumber || '').trim();

  if (!smRef && !localAwb) {
    return {
      success: false,
      code: 'SHIPMOZO_REFERENCE_MISSING',
      message: 'No Shipmozo order id or AWB on this order yet'
    };
  }

  let hydrateResult = { success: true, hydrated: false };
  if (smRef || order.orderId) {
    hydrateResult = await hydrateOrderFromShipmozoPanel(order, {
      source: `${source}_hydrate`,
      probeLabel: options.probeLabel !== false
    });
    if (!hydrateResult.success) {
      return {
        success: false,
        code: hydrateResult.code || 'HYDRATE_FAILED',
        message: hydrateResult.message || 'Shipmozo panel hydrate failed',
        panelSyncAttempted: true,
        hydrate: hydrateResult
      };
    }
  }

  let working =
    hydrateResult.order || (await Order.findOne({ orderId: order.orderId })) || order;

  const awbAfter = String(working.shipmentInfo?.awbCode || working.shipmentInfo?.trackingNumber || '').trim();
  if (!awbAfter) {
    const panelBooked = isShipmozoPanelBooked(working.shipmentInfo);
    return {
      success: true,
      partial: panelBooked,
      code: panelBooked ? 'SHIPMOZO_PANEL_BOOKED_AWB_PENDING' : 'SHIPMOZO_AWB_MISSING',
      message: panelBooked
        ? 'Courier is booked on Shipmozo (status synced). AWB not returned yet — refresh again shortly or check Shipmozo panel.'
        : 'Shipmozo order exists but AWB is not assigned yet. Complete courier assign on Shipmozo panel, then refresh again.',
      panelSyncAttempted: true,
      hydrated: Boolean(hydrateResult.hydrated),
      order: working,
      hydrate: hydrateResult
    };
  }

  const reconcileResult = await reconcileOrderFromShipmozo(working, {
    source,
    allowOrderStatusUpdate: options.allowOrderStatusUpdate !== false,
    notify: options.notify !== false
  });

  if (!reconcileResult.success) {
    return {
      success: false,
      code: reconcileResult.code || 'SHIPMOZO_TRACK_FAILED',
      message: reconcileResult.message || 'Shipmozo track reconcile failed',
      panelSyncAttempted: true,
      hydrated: Boolean(hydrateResult.hydrated),
      order: working,
      hydrate: hydrateResult,
      tracking: reconcileResult.tracking || null
    };
  }

  let fresh = reconcileResult.order || (await Order.findOne({ orderId: order.orderId }));

  if (fresh && !fresh.shipmentInfo?.labelDownloaded && options.probeLabel !== false) {
    try {
      const labelReady = await probeShipmozoLabelReady(awbAfter);
      if (labelReady) {
        const { applyUpsertShipmentInfo } = require('../controllers/order.controller');
        await applyUpsertShipmentInfo({
          order: fresh,
          shipmentPayload: { labelDownloaded: true },
          trigger: `${source}_label_probe`,
          allowOrderStatusUpdate: false
        });
        fresh = (await Order.findOne({ orderId: order.orderId })) || fresh;
      }
    } catch (labelErr) {
      logger.debug('[shipmozoPanelSync] post-reconcile label probe failed', {
        orderId: order.orderId,
        message: labelErr?.message || String(labelErr)
      });
    }
  }

  try {
    const { evaluateAndPersistShipmentOps } = require('./shipmentOps');
    await evaluateAndPersistShipmentOps(fresh, { source: `${source}_post` });
    fresh = (await Order.findOne({ orderId: order.orderId })) || fresh;
  } catch (_) {
    /* non-blocking */
  }

  return {
    success: true,
    partial: false,
    message: hydrateResult.hydrated
      ? 'Synced from Shipmozo panel and refreshed tracking.'
      : 'Shipmozo tracking refreshed for this order.',
    order: fresh,
    provider: SHIPPING_PROVIDERS.SHIPMOZO,
    panelSyncAttempted: true,
    hydrated: Boolean(hydrateResult.hydrated),
    hydrate: hydrateResult,
    tracking: reconcileResult.tracking || null,
    warehouseDelivered: Boolean(reconcileResult.warehouseDelivered),
    previousProviderStatus: reconcileResult.previousProviderStatus || null,
    previousOrderStatus: reconcileResult.previousOrderStatus || null,
    currentProviderStatus: reconcileResult.currentProviderStatus || null,
    currentOrderStatus: reconcileResult.currentOrderStatus || null
  };
}

/**
 * @param {object | null | undefined} shipmentInfo
 */
function hasShipmozoSyncReference(shipmentInfo) {
  const si = shipmentInfo || {};
  return Boolean(
    String(si.awbCode || si.trackingNumber || '').trim() ||
      resolveShipmozoMarketplaceOrderId(si)
  );
}

module.exports = {
  resolveShipmozoMarketplaceOrderId,
  resolveShipmozoDetailOrderIds,
  parseShipmozoOrderDetail,
  deepFindAwb,
  isShipmozoPanelBooked,
  isShipmozoPanelBookedStatus,
  probeShipmozoLabelReady,
  hydrateOrderFromShipmozoPanel,
  syncShipmentFromShipmozo,
  hasShipmozoSyncReference
};
