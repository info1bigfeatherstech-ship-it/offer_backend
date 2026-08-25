/**
 * Shipmozo shipping webhook — push status updates into our Order DB.
 *
 * Scope: Shipmozo orders ONLY. Never mutates Shiprocket orders.
 * Persistence path mirrors shipmozoReconcile (applyUpsertShipmentInfo + ops + RTO).
 *
 * Panel setup example:
 *   https://<api-host>/api/orders/shipping/shipmozo/webhook?token=<SHIPMOZO_WEBHOOK_TOKEN>
 */
const Order = require('../models/Order');
const logger = require('../utils/logger');
const {
  SHIPPING_PROVIDERS,
  isShipmozoOrder,
  resolveOrderShippingProvider
} = require('../constants/shippingProviders');
const { isRtoProviderStatus } = require('./shipmentOps/shiprocketStatusMap');

function trimStr(v) {
  const s = String(v == null ? '' : v).trim();
  return s || null;
}

function normalizeShipmentEventTimestamp(value) {
  if (!value) return null;
  const dt = new Date(value);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/**
 * Extract identifiers + status + timeline from Shipmozo webhook JSON.
 * Tolerant of typos (refrence_id) and nested wrappers.
 * @param {unknown} rawBody
 */
function parseShipmozoWebhookPayload(rawBody) {
  let body = rawBody;
  if (body && typeof body === 'object' && body.data != null && typeof body.data === 'object') {
    const hasTopStatus = body.current_status || body.awb_number || body.order_id;
    if (!hasTopStatus) body = body.data;
  }
  if (!body || typeof body !== 'object') {
    return {
      ok: false,
      code: 'INVALID_PAYLOAD',
      message: 'Webhook body must be a JSON object'
    };
  }

  const channelOrderId = trimStr(body.order_id || body.orderId || body.channel_order_id);
  const referenceId = trimStr(
    body.refrence_id || // Shipmozo docs typo
      body.reference_id ||
      body.referenceId ||
      body.ref_id
  );
  const awbCode = trimStr(body.awb_number || body.awb || body.awbCode || body.awb_no);
  const currentStatus = trimStr(
    body.current_status || body.currentStatus || body.status || body.shipment_status
  );
  const courier = trimStr(body.carrier || body.courier || body.courier_name || body.courierName);
  const estimatedDelivery = trimStr(
    body.expected_delivery_date || body.estimated_delivery_date || body.edd
  );
  const statusTime = trimStr(body.status_time || body.statusTime || body.updated_at);
  const shipmentType = trimStr(body.shipment_type || body.shipmentType || 'Forward');

  const feed = body.status_feed || body.statusFeed || body.scan_detail || null;
  let scans = [];
  if (Array.isArray(feed)) {
    scans = feed;
  } else if (feed && typeof feed === 'object') {
    if (Array.isArray(feed.scan)) scans = feed.scan;
    else if (Array.isArray(feed.scans)) scans = feed.scans;
    else if (Array.isArray(feed.scan_detail)) scans = feed.scan_detail;
  } else if (Array.isArray(body.scan_detail)) {
    scans = body.scan_detail;
  } else if (Array.isArray(body.scans)) {
    scans = body.scans;
  }

  const events = scans
    .filter((s) => s && typeof s === 'object')
    .map((s) => {
      const at =
        normalizeShipmentEventTimestamp(s.date || s.time || s.status_time || s.timestamp) ||
        null;
      return {
        status: String(s.status || s.current_status || s.scan_status || s.message || '').trim() || 'Update',
        location: String(s.location || s.city || '').trim() || null,
        description: String(s.description || s.remark || s.comment || '').trim() || null,
        time: at || s.date || s.time || null,
        at: at || undefined,
        code: s.code || s.status_code || null,
        raw: s
      };
    });

  if (!channelOrderId && !referenceId && !awbCode) {
    return {
      ok: false,
      code: 'SHIPMOZO_WEBHOOK_ID_REQUIRED',
      message: 'order_id, refrence_id/reference_id, or awb_number is required'
    };
  }

  return {
    ok: true,
    channelOrderId,
    referenceId,
    awbCode,
    currentStatus,
    courier,
    estimatedDelivery,
    statusTime,
    shipmentType,
    events,
    raw: body
  };
}

/**
 * Auth for Shipmozo panel URL (query token) + optional headers.
 * If SHIPMOZO_WEBHOOK_TOKEN is unset, allow (dev) but never block Shiprocket path.
 * @param {import('express').Request} req
 */
function verifyShipmozoWebhookAuth(req) {
  const configured = String(process.env.SHIPMOZO_WEBHOOK_TOKEN || '').trim();
  if (!configured) {
    if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
      logger.warn('[shipmozoWebhook] SHIPMOZO_WEBHOOK_TOKEN is not set — webhook is open');
    }
    return { ok: true, skipped: true };
  }

  const incoming = String(
    req.headers['x-shipmozo-token'] ||
      req.headers['x-webhook-token'] ||
      req.query?.token ||
      req.query?.webhook_token ||
      ''
  ).trim();

  if (!incoming || incoming !== configured) {
    return { ok: false, code: 'SHIPMOZO_WEBHOOK_UNAUTHORIZED', message: 'Invalid Shipmozo webhook token' };
  }
  return { ok: true, skipped: false };
}

/**
 * Find order for webhook identifiers. Prefer channel orderId, then Shipmozo ids, then AWB.
 * @param {{ channelOrderId?: string|null, referenceId?: string|null, awbCode?: string|null }} ids
 */
async function findOrderForShipmozoWebhook(ids) {
  const channelOrderId = trimStr(ids.channelOrderId);
  const referenceId = trimStr(ids.referenceId);
  const awbCode = trimStr(ids.awbCode);

  let order = null;

  if (channelOrderId) {
    order = await Order.findOne({ orderId: channelOrderId });
  }

  if (!order && referenceId) {
    order = await Order.findOne({
      $or: [
        { 'shipmentInfo.shipmozoOrderId': referenceId },
        { 'shipmentInfo.shipmozoReferenceId': referenceId },
        { 'shipmentInfo.shipmentId': referenceId },
        { orderId: referenceId }
      ]
    });
  }

  // Some panels put marketplace id in order_id and channel id elsewhere
  if (!order && channelOrderId) {
    order = await Order.findOne({
      $or: [
        { 'shipmentInfo.shipmozoOrderId': channelOrderId },
        { 'shipmentInfo.shipmozoReferenceId': channelOrderId },
        { 'shipmentInfo.shipmentId': channelOrderId }
      ]
    });
  }

  if (!order && awbCode) {
    order = await Order.findOne({
      $or: [{ 'shipmentInfo.awbCode': awbCode }, { 'shipmentInfo.trackingNumber': awbCode }]
    });
  }

  return order;
}

function wasRtoish(orderLike) {
  if (!orderLike) return false;
  if (String(orderLike.orderStatus || '').toLowerCase() === 'rto') return true;
  return isRtoProviderStatus(orderLike.shipmentInfo?.providerStatus);
}

function isCancelStatus(status) {
  const statusNorm = String(status || '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ');
  return (
    /\bcancel/.test(statusNorm) ||
    /shipment cancelled|order cancelled|awb cancel/.test(statusNorm)
  );
}

/**
 * Merge webhook scan events with existing rawEvents (append-only, capped).
 * @param {object} order
 * @param {Array<object>} webhookEvents
 * @param {string|null} currentStatus
 * @param {string|null} statusTime
 */
function mergeWebhookEvents(order, webhookEvents, currentStatus, statusTime) {
  const existing = Array.isArray(order.shipmentInfo?.rawEvents)
    ? [...order.shipmentInfo.rawEvents]
    : Array.isArray(order.shipmentInfo?.events)
      ? [...order.shipmentInfo.events]
      : [];

  const incoming =
    Array.isArray(webhookEvents) && webhookEvents.length
      ? webhookEvents
      : currentStatus
        ? [
            {
              status: currentStatus,
              location: null,
              description: null,
              at: normalizeShipmentEventTimestamp(statusTime) || new Date(),
              time: statusTime || null,
              raw: { source: 'shipmozo_webhook_status' }
            }
          ]
        : [];

  // Prefer full timeline from webhook when present; else append
  if (incoming.length >= 2) {
    return incoming.slice(-50);
  }

  const next = [...existing];
  for (const ev of incoming) {
    const last = next[next.length - 1];
    const sameStatus =
      last &&
      String(last.status || '').toLowerCase() === String(ev.status || '').toLowerCase() &&
      String(last.time || last.at || '') === String(ev.time || ev.at || '');
    if (!sameStatus) next.push(ev);
  }
  return next.slice(-50);
}

/**
 * Process one Shipmozo webhook delivery.
 * @param {unknown} rawBody
 * @param {{ source?: string }} [options]
 */
async function processShipmozoWebhook(rawBody, options = {}) {
  const source = String(options.source || 'shipmozo_webhook').trim() || 'shipmozo_webhook';
  const parsed = parseShipmozoWebhookPayload(rawBody);
  if (!parsed.ok) {
    return {
      success: false,
      httpStatus: 400,
      code: parsed.code,
      message: parsed.message
    };
  }

  let order;
  try {
    order = await findOrderForShipmozoWebhook(parsed);
  } catch (findErr) {
    logger.error('[shipmozoWebhook] order lookup failed', {
      message: findErr?.message || String(findErr),
      channelOrderId: parsed.channelOrderId,
      referenceId: parsed.referenceId,
      awbCode: parsed.awbCode
    });
    return {
      success: false,
      httpStatus: 500,
      code: 'SHIPMOZO_WEBHOOK_LOOKUP_FAILED',
      message: 'Failed to look up order for Shipmozo webhook'
    };
  }

  if (!order) {
    return {
      success: false,
      httpStatus: 404,
      code: 'ORDER_NOT_FOUND',
      message: 'Order not found for Shipmozo webhook payload'
    };
  }

  // Hard guard — never apply Shipmozo webhook to Shiprocket / other providers
  if (!isShipmozoOrder(order)) {
    logger.warn('[shipmozoWebhook] ignored non-Shipmozo order', {
      orderId: order.orderId,
      provider: resolveOrderShippingProvider(order)
    });
    return {
      success: false,
      httpStatus: 409,
      code: 'NOT_SHIPMOZO_ORDER',
      message: 'Matched order is not a Shipmozo shipment — webhook ignored',
      orderId: order.orderId,
      provider: resolveOrderShippingProvider(order)
    };
  }

  const previousProviderStatus = order.shipmentInfo?.providerStatus || null;
  const previousOrderStatus = order.orderStatus || null;
  const previousRto = wasRtoish(order);

  const providerStatus = parsed.currentStatus || order.shipmentInfo?.providerStatus || null;

  // Cancel → local reset (same behavior as track reconcile)
  if (isCancelStatus(providerStatus)) {
    try {
      const { applyLocalShipmentReset } = require('./shiprocketReconcile.service');
      const resetOrder = await applyLocalShipmentReset(order, {
        reason: providerStatus || 'Cancelled on Shipmozo',
        trigger: `${source}_cancel_detected`,
        appendEvent: true
      });
      if (resetOrder) {
        try {
          const { evaluateAndPersistShipmentOps } = require('./shipmentOps');
          await evaluateAndPersistShipmentOps(resetOrder, { source: `${source}_cancel` });
        } catch (_) {
          /* non-blocking */
        }
        const freshReset = await Order.findOne({ orderId: order.orderId });
        return {
          success: true,
          cancelled: true,
          message: 'Shipmozo reports shipment cancelled — local AWB cleared for re-ship.',
          orderId: order.orderId,
          order: freshReset || resetOrder
        };
      }
    } catch (cancelErr) {
      logger.warn('[shipmozoWebhook] cancel reset failed', {
        orderId: order.orderId,
        message: cancelErr?.message || String(cancelErr)
      });
      // fall through to normal upsert
    }
  }

  const mergedEvents = mergeWebhookEvents(
    order,
    parsed.events,
    providerStatus,
    parsed.statusTime
  );

  const shipmentPayload = {
    provider: SHIPPING_PROVIDERS.SHIPMOZO,
    providerStatus: providerStatus || undefined,
    events: mergedEvents
  };

  if (parsed.awbCode) {
    shipmentPayload.awbCode = parsed.awbCode;
    shipmentPayload.trackingNumber = parsed.awbCode;
  }
  if (parsed.courier) shipmentPayload.courier = parsed.courier;
  if (parsed.estimatedDelivery) shipmentPayload.estimatedDelivery = parsed.estimatedDelivery;
  if (parsed.referenceId && !order.shipmentInfo?.shipmozoReferenceId) {
    shipmentPayload.shipmozoReferenceId = parsed.referenceId;
  }
  if (
    parsed.channelOrderId &&
    parsed.channelOrderId !== order.orderId &&
    !order.shipmentInfo?.shipmozoOrderId
  ) {
    // Marketplace id sometimes arrives as order_id when channel id is our OWB id in reference
    shipmentPayload.shipmozoOrderId = parsed.channelOrderId;
  }

  try {
    const { applyUpsertShipmentInfo } = require('../controllers/order.controller');
    await applyUpsertShipmentInfo({
      order,
      shipmentPayload,
      trigger: source,
      allowOrderStatusUpdate: true
    });
  } catch (upsertErr) {
    logger.error('[shipmozoWebhook] upsert failed', {
      orderId: order.orderId,
      message: upsertErr?.message || String(upsertErr),
      stack: upsertErr?.stack
    });
    return {
      success: false,
      httpStatus: 500,
      code: 'SHIPMOZO_WEBHOOK_UPSERT_FAILED',
      message: upsertErr?.message || 'Failed to persist Shipmozo webhook update'
    };
  }

  let fresh = await Order.findOne({ orderId: order.orderId });
  if (!fresh) {
    return {
      success: false,
      httpStatus: 500,
      code: 'ORDER_NOT_FOUND_AFTER_UPSERT',
      message: 'Order missing after webhook upsert'
    };
  }

  // RTO insights + default freight (same as reconcile)
  const ps = String(fresh.shipmentInfo?.providerStatus || '');
  const isRtoishNow =
    String(fresh.orderStatus || '').toLowerCase() === 'rto' || isRtoProviderStatus(ps);

  if (isRtoishNow) {
    try {
      const { persistRtoTrackingInsights } = require('./rtoRefund.service');
      const { syncShipmozoRtoFreightDefault } = require('./shipmozoReconcile.service');
      const insightsChanged = persistRtoTrackingInsights(fresh);
      try {
        await syncShipmozoRtoFreightDefault(fresh, { persist: false });
      } catch (_) {
        /* non-blocking */
      }
      if (insightsChanged || fresh.isModified?.('returnInfo') || fresh.isModified?.('shipmentInfo')) {
        if (typeof fresh.markModified === 'function') {
          fresh.markModified('returnInfo');
          fresh.markModified('shipmentInfo');
        }
        await fresh.save();
      }
    } catch (rtoErr) {
      logger.warn('[shipmozoWebhook] RTO insights failed', {
        orderId: fresh.orderId,
        message: rtoErr?.message || String(rtoErr)
      });
    }
  }

  try {
    const { evaluateAndPersistShipmentOps } = require('./shipmentOps');
    await evaluateAndPersistShipmentOps(fresh, { source });
    fresh = (await Order.findOne({ orderId: order.orderId })) || fresh;
  } catch (_) {
    /* non-blocking */
  }

  if (!previousRto && wasRtoish(fresh)) {
    try {
      const { notifyRtoInitiated } = require('./rtoNotification.service');
      await notifyRtoInitiated(fresh);
    } catch (notifyErr) {
      logger.warn('[shipmozoWebhook] RTO notify failed', {
        orderId: fresh.orderId,
        message: notifyErr?.message || String(notifyErr)
      });
    }
  }

  return {
    success: true,
    message: 'Shipmozo webhook processed',
    orderId: fresh.orderId,
    previousProviderStatus,
    previousOrderStatus,
    currentProviderStatus: fresh.shipmentInfo?.providerStatus || null,
    currentOrderStatus: fresh.orderStatus || null,
    provider: SHIPPING_PROVIDERS.SHIPMOZO
  };
}

module.exports = {
  parseShipmozoWebhookPayload,
  verifyShipmozoWebhookAuth,
  findOrderForShipmozoWebhook,
  mergeWebhookEvents,
  processShipmozoWebhook,
  isCancelStatus
};
