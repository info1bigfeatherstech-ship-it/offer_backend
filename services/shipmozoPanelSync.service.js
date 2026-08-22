/**
 * Shipmozo panel parity sync — pull AWB / courier / status from Shipmozo when
 * assignment happened on their panel (Ship Now failed or manual override).
 *
 * Shiprocket already hydrates via reconcileOrderFromShiprocket(full).
 * Shipmozo previously required local AWB before any sync — this closes that gap.
 */
const Order = require('../models/Order');
const ShipmozoService = require('../utils/shipmozo');
const logger = require('../utils/logger');
const { SHIPPING_PROVIDERS, isShipmozoOrder } = require('../constants/shippingProviders');
const { reconcileOrderFromShipmozo } = require('./shipmozoReconcile.service');

/**
 * @param {object | null | undefined} shipmentInfo
 */
function resolveShipmozoMarketplaceOrderId(shipmentInfo) {
  const si = shipmentInfo || {};
  const id = String(si.shipmozoOrderId || si.shipmentId || si.shipmozoReferenceId || '').trim();
  return id || null;
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

  const nested =
    row.shipment && typeof row.shipment === 'object'
      ? row.shipment
      : row.order && typeof row.order === 'object'
        ? row.order
        : null;

  const sources = nested ? [row, nested] : [row];

  let awbCode = null;
  let courier = null;
  let assignedCourierId = null;
  let providerStatus = null;
  let pickupDate = null;

  for (const src of sources) {
    awbCode =
      awbCode ||
      pickFirstString(src, [
        'awb_number',
        'awb',
        'awb_no',
        'tracking_number',
        'trackingNumber',
        'waybill'
      ]);
    courier =
      courier ||
      pickFirstString(src, [
        'courier',
        'courier_name',
        'courier_company',
        'courier_company_name',
        'assigned_courier'
      ]);
    assignedCourierId =
      assignedCourierId ||
      pickFirstCourierId(src, ['courier_id', 'courierId', 'assigned_courier_id', 'courier_company_id']);
    providerStatus =
      providerStatus ||
      pickFirstString(src, [
        'order_status',
        'status',
        'current_status',
        'shipment_status',
        'provider_status'
      ]);
    pickupDate =
      pickupDate ||
      pickFirstString(src, ['pickup_date', 'pickupDate', 'scheduled_pickup_date']);
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
 * Pull assignment state from Shipmozo panel into Mongo (no tracking reconcile).
 * @param {import('mongoose').Document|object} order
 * @param {{ source?: string, probeLabel?: boolean }} [opts]
 */
async function hydrateOrderFromShipmozoPanel(order, opts = {}) {
  const source = String(opts.source || 'shipmozo_panel_hydrate').trim() || 'shipmozo_panel_hydrate';

  if (!order?.orderId) {
    return { success: false, code: 'ORDER_REQUIRED', hydrated: false, message: 'Order is required' };
  }
  if (!isShipmozoOrder(order)) {
    return { success: false, code: 'NOT_SHIPMOZO_ORDER', hydrated: false, message: 'Not a Shipmozo order' };
  }

  const smOrderId = resolveShipmozoMarketplaceOrderId(order.shipmentInfo);
  if (!smOrderId) {
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

  let detailRes;
  try {
    detailRes = await ShipmozoService.getOrderDetail(smOrderId);
  } catch (err) {
    logger.error('[shipmozoPanelSync] getOrderDetail threw', {
      orderId: order.orderId,
      smOrderId,
      message: err?.message || String(err)
    });
    return {
      success: false,
      code: 'SHIPMOZO_DETAIL_ERROR',
      hydrated: false,
      message: err?.message || 'Shipmozo order detail failed'
    };
  }

  if (!detailRes?.success) {
    return {
      success: false,
      code: 'SHIPMOZO_DETAIL_FAILED',
      hydrated: false,
      message: detailRes?.message || 'Shipmozo order detail failed',
      raw: detailRes?.raw || null
    };
  }

  const parsed = parseShipmozoOrderDetail(detailRes.data);
  const awbCode = parsed.awbCode ? String(parsed.awbCode).trim() : null;

  if (!awbCode && !parsed.courier && !parsed.providerStatus && !parsed.assignedCourierId) {
    return {
      success: true,
      hydrated: false,
      code: 'NO_PANEL_ASSIGNMENT_YET',
      message: 'Shipmozo has no AWB/courier on this order yet',
      order: await Order.findOne({ orderId: order.orderId })
    };
  }

  const shipmentPayload = {
    provider: SHIPPING_PROVIDERS.SHIPMOZO,
    shipmozoOrderId: order.shipmentInfo?.shipmozoOrderId || smOrderId,
    shipmentId: order.shipmentInfo?.shipmentId || smOrderId
  };

  if (awbCode) {
    shipmentPayload.awbCode = awbCode;
    shipmentPayload.trackingNumber = awbCode;
  }
  if (parsed.courier) shipmentPayload.courier = parsed.courier;
  if (parsed.assignedCourierId) shipmentPayload.assignedCourierId = parsed.assignedCourierId;
  if (parsed.providerStatus) shipmentPayload.providerStatus = parsed.providerStatus;
  if (parsed.pickupDate) shipmentPayload.pickupDate = parsed.pickupDate;

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

  const gotAwb = Boolean(
    String(fresh.shipmentInfo?.awbCode || fresh.shipmentInfo?.trackingNumber || '').trim()
  );
  if (gotAwb && !hadLocalAwb) {
    const st = String(fresh.orderStatus || '').toLowerCase();
    if (['pending', 'confirmed'].includes(st)) {
      fresh.orderStatus = 'processing';
      fresh.markModified('orderStatus');
      try {
        await fresh.save();
        fresh = await Order.findOne({ orderId: order.orderId });
      } catch (saveErr) {
        logger.warn('[shipmozoPanelSync] confirmed→processing promote failed', {
          orderId: order.orderId,
          message: saveErr?.message || String(saveErr)
        });
      }
    }
  }

  try {
    const { evaluateAndPersistShipmentOps } = require('./shipmentOps');
    await evaluateAndPersistShipmentOps(fresh, { source });
    fresh = (await Order.findOne({ orderId: order.orderId })) || fresh;
  } catch (_) {
    /* non-blocking */
  }

  return {
    success: true,
    hydrated: true,
    awbCode: gotAwb ? String(fresh.shipmentInfo?.awbCode || fresh.shipmentInfo?.trackingNumber || '') : null,
    labelDownloaded: Boolean(fresh?.shipmentInfo?.labelDownloaded),
    parsed,
    order: fresh
  };
}

/**
 * Full Shipmozo sync: panel hydrate (if needed) → track reconcile → label probe.
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

  const smRef = resolveShipmozoMarketplaceOrderId(order.shipmentInfo);
  const localAwb = String(order.shipmentInfo?.awbCode || order.shipmentInfo?.trackingNumber || '').trim();

  if (!smRef && !localAwb) {
    return {
      success: false,
      code: 'SHIPMOZO_REFERENCE_MISSING',
      message: 'No Shipmozo order id or AWB on this order yet'
    };
  }

  let hydrateResult = { success: true, hydrated: false };
  if (!localAwb && smRef) {
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
    return {
      success: true,
      code: 'SHIPMOZO_AWB_MISSING',
      message:
        'Shipmozo order exists but AWB is not assigned yet. Complete courier assign on Shipmozo panel, then refresh again.',
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
  parseShipmozoOrderDetail,
  probeShipmozoLabelReady,
  hydrateOrderFromShipmozoPanel,
  syncShipmentFromShipmozo,
  hasShipmozoSyncReference
};
