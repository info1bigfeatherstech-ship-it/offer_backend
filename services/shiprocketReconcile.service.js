/**
 * Unified Shiprocket → Order reconciliation.
 * Shiprocket is the source of truth for carrier status, IDs, pickup, and reset detection.
 */

const Order = require('../models/Order');
const ShiprocketService = require('../utils/shiprocket');
const { evaluateAndPersistShipmentOps, buildShipmentOpsView } = require('./shipmentOps');
const {
  collectForwardOrderTexts,
  detectForwardOrderReset
} = require('./shipmentOps/shiprocketStatusMap');

/**
 * Clear stale forward-shipment fields after provider reset / auto-cancel.
 * Keeps shiprocketOrderId so the channel order can be re-shipped.
 * @param {import('mongoose').Document} order
 * @param {{ reason?: string|null, trigger?: string, appendEvent?: boolean }} [options]
 */
async function applyLocalShipmentReset(order, options = {}) {
  const reason = String(options.reason || 'Shipment reset on Shiprocket').trim();
  const trigger = options.trigger || 'shiprocket_reset_clear';
  const si = { ...(order.shipmentInfo || {}) };

  const nextEvents = Array.isArray(si.rawEvents) ? [...si.rawEvents] : [];
  if (options.appendEvent !== false) {
    nextEvents.push({
      status: reason,
      description: reason,
      at: new Date(),
      raw: { source: trigger }
    });
  }

  order.shipmentInfo = {
    ...si,
    awbCode: null,
    trackingNumber: null,
    courier: null,
    assignedCourierId: null,
    pickupDate: null,
    pickupScheduledAt: null,
    manifestUrl: null,
    labelUrl: null,
    manifestGeneratedAt: null,
    lastPickupError: null,
    providerStatus: reason,
    providerSnapshot: null,
    lastSyncAt: new Date(),
    lastSyncSource: trigger,
    rawEvents:
      options.appendEvent === false
        ? []
        : nextEvents.slice(-50)
  };
  order.markModified('shipmentInfo');
  await order.save();

  await evaluateAndPersistShipmentOps(order, { source: trigger });
  return Order.findOne({ orderId: order.orderId });
}

/**
 * @param {Array<object>|null|undefined} existing
 * @param {string} reason
 */
function appendResetEvent(existing, reason) {
  const next = Array.isArray(existing) ? [...existing] : [];
  next.push({
    status: reason,
    description: reason,
    at: new Date(),
    raw: { source: 'reconcile_reset' }
  });
  return next.slice(-50);
}

/**
 * Build upsert payload from forward snapshot; handles reset clears.
 * @param {object} snapshot
 * @param {import('mongoose').Document} order
 */
function buildPayloadFromSnapshot(snapshot, order) {
  const si = order.shipmentInfo || {};
  const hadLocalAwb = Boolean(si.awbCode || si.trackingNumber);

  const reset = detectForwardOrderReset({
    statusCode: snapshot.statusCode,
    statusLabel: snapshot.providerStatus,
    statusMessage: snapshot.statusMessage,
    texts: snapshot.signalTexts,
    awbCode: snapshot.awbCode,
    hadLocalAwb
  });

  if (reset.resetDetected) {
    return {
      reset: true,
      resetReason: reset.reason,
      payload: {
        providerStatus: reset.reason,
        providerSnapshot: snapshot.providerSnapshot || null,
        pickupDate: null,
        lastPickupError: null,
        awbCode: null,
        trackingNumber: null,
        courier: null,
        assignedCourierId: null,
        manifestUrl: null,
        labelUrl: null,
        events: appendResetEvent(si.rawEvents, reset.reason)
      }
    };
  }

  const payload = {
    providerSnapshot: snapshot.providerSnapshot || null
  };

  if (snapshot.shiprocketOrderId) payload.shiprocketOrderId = snapshot.shiprocketOrderId;
  if (snapshot.shipmentId) payload.shipmentId = snapshot.shipmentId;
  if (snapshot.awbCode) {
    payload.awbCode = snapshot.awbCode;
    payload.trackingNumber = snapshot.trackingNumber || snapshot.awbCode;
  } else if (hadLocalAwb && !snapshot.awbCode) {
    payload.awbCode = null;
    payload.trackingNumber = null;
  }
  if (snapshot.courier) payload.courier = snapshot.courier;
  if (snapshot.labelUrl) payload.labelUrl = snapshot.labelUrl;
  if (snapshot.manifestUrl) payload.manifestUrl = snapshot.manifestUrl;
  if (snapshot.providerStatus) payload.providerStatus = snapshot.providerStatus;
  if (snapshot.pickupScheduled === true && snapshot.pickupDate) {
    payload.pickupDate = snapshot.pickupDate;
  } else if (snapshot.pickupScheduled === false) {
    payload.pickupDate = null;
    payload.pickupScheduledAt = null;
  }

  return { reset: false, resetReason: null, payload };
}

/**
 * Persist courier pickup day from Shiprocket.
 * @param {import('mongoose').Document} order
 * @param {object} snap
 * @param {string} trigger
 */
async function persistPickupDateFromSnapshot(order, snap, trigger) {
  const freshOrder = await Order.findOne({ orderId: order.orderId });
  if (!freshOrder) return { success: false, pickupDate: null, source: 'none' };

  const { applyUpsertShipmentInfo } = require('../controllers/order.controller');
  const si = freshOrder.shipmentInfo || {};

  if (snap && snap.pickupScheduled === false) {
    if (si.pickupDate || si.pickupScheduledAt) {
      await applyUpsertShipmentInfo({
        order: freshOrder,
        shipmentPayload: {
          pickupDate: null,
          pickupScheduledAt: null,
          lastPickupError: null
        },
        trigger: trigger || 'reconcile_clear_stale_pickup',
        allowOrderStatusUpdate: false
      });
    }
    return { success: true, pickupDate: null, source: 'not_scheduled' };
  }

  if (!snap?.pickupScheduled && !snap?.pickupDate) {
    return { success: true, pickupDate: si.pickupDate || null, source: 'none' };
  }

  const shipmentId = si.shipmentId || snap?.shipmentId;
  const resolved = await ShiprocketService.resolveAuthoritativePickupDate({
    shipmentId,
    shiprocketOrderId: si.shiprocketOrderId || snap?.shiprocketOrderId,
    channelOrderId: freshOrder.orderId,
    allowPickupListFallback: snap?.pickupScheduled === true
  });

  const payload = {};
  if (
    resolved.success &&
    resolved.pickupDate &&
    ShiprocketService.isPlausibleCourierPickupYmd(resolved.pickupDate)
  ) {
    payload.pickupDate = resolved.pickupDate;
    if (!si.pickupScheduledAt) {
      payload.pickupScheduledAt = new Date();
    }
    payload.lastPickupError = null;
  } else if (si.pickupDate && !ShiprocketService.isPlausibleCourierPickupYmd(si.pickupDate)) {
    payload.pickupDate = null;
  }

  if (Object.keys(payload).length === 0) {
    return {
      success: resolved.success,
      pickupDate: si.pickupDate || null,
      source: resolved.source || 'none'
    };
  }

  await applyUpsertShipmentInfo({
    order: freshOrder,
    shipmentPayload: payload,
    trigger: trigger || 'reconcile_pickup_date',
    allowOrderStatusUpdate: false
  });

  const updated = await Order.findOne({ orderId: order.orderId });
  return {
    success: true,
    pickupDate: updated?.shipmentInfo?.pickupDate || payload.pickupDate || null,
    source: resolved.source || 'reconcile'
  };
}

/**
 * Reconcile order state from Shiprocket (orders/show + optional tracking).
 * @param {import('mongoose').Document|string} orderOrId
 * @param {{ source?: string, mode?: 'full'|'forward'|'tracking', allowOrderStatusUpdate?: boolean }} [options]
 */
async function reconcileOrderFromShiprocket(orderOrId, options = {}) {
  const source = options.source || 'reconcile';
  const mode = options.mode || 'full';
  const allowOrderStatusUpdate =
    options.allowOrderStatusUpdate != null
      ? Boolean(options.allowOrderStatusUpdate)
      : source.includes('admin');

  let order =
    typeof orderOrId === 'string'
      ? await Order.findOne({ orderId: orderOrId.trim() })
      : orderOrId;

  if (!order) {
    return { success: false, code: 'ORDER_NOT_FOUND', message: 'Order not found' };
  }

  const si = order.shipmentInfo || {};
  const hasSr = si.shiprocketOrderId || si.shipmentId || si.awbCode;
  if (!hasSr && mode !== 'forward') {
    return { success: false, code: 'SHIPROCKET_ORDER_MISSING', message: 'No Shiprocket reference on order' };
  }

  const { applyUpsertShipmentInfo } = require('../controllers/order.controller');

  let snapshot = null;
  let resetApplied = false;

  if (mode === 'forward' || mode === 'full') {
    const lookup = await ShiprocketService.fetchForwardOrderSnapshot({
      shiprocketOrderId: si.shiprocketOrderId,
      channelOrderId: order.orderId
    });
    if (!lookup.success || !lookup.snapshot) {
      return {
        success: false,
        code: lookup.code || 'SYNC_FAILED',
        message: lookup.message || 'Could not load order from Shiprocket'
      };
    }
    snapshot = lookup.snapshot;

    const built = buildPayloadFromSnapshot(snapshot, order);
    if (built.reset) {
      resetApplied = true;
      await applyLocalShipmentReset(order, {
        reason: built.resetReason,
        trigger: `${source}_reset`,
        appendEvent: true
      });
      order = await Order.findOne({ orderId: order.orderId });
      if (!order) {
        return { success: false, code: 'ORDER_NOT_FOUND', message: 'Order not found after reset' };
      }
    } else {
      await applyUpsertShipmentInfo({
        order,
        shipmentPayload: built.payload,
        trigger: source,
        allowOrderStatusUpdate
      });
      order = await Order.findOne({ orderId: order.orderId });

      const pickupResolved = await persistPickupDateFromSnapshot(order, snapshot, `${source}_pickup_date`);
      if (pickupResolved.success && pickupResolved.pickupDate) {
        snapshot.pickupDate = pickupResolved.pickupDate;
      }
    }
  }

  if (mode === 'tracking' || mode === 'full') {
    order = await Order.findOne({ orderId: order.orderId });
    const awb = order?.shipmentInfo?.awbCode || order?.shipmentInfo?.trackingNumber;
    const shipmentId = order?.shipmentInfo?.shipmentId;
    if (order && (awb || shipmentId)) {
      const trackingResult = await ShiprocketService.getTracking({ awbCode: awb, shipmentId });
      if (trackingResult?.success) {
        const trackReset = detectForwardOrderReset({
          statusLabel: trackingResult.currentStatus,
          texts: (trackingResult.events || []).map((e) => e.status || e.description).filter(Boolean),
          awbCode: awb,
          hadLocalAwb: Boolean(awb)
        });
        if (trackReset.resetDetected) {
          resetApplied = true;
          await applyLocalShipmentReset(order, {
            reason: trackReset.reason,
            trigger: `${source}_tracking_reset`
          });
        } else {
          await applyUpsertShipmentInfo({
            order,
            shipmentPayload: {
              ...trackingResult,
              providerStatus: trackingResult.currentStatus || order.shipmentInfo?.providerStatus
            },
            trigger: `${source}_tracking`,
            allowOrderStatusUpdate
          });
        }
      }
    }
  }

  order = await Order.findOne({ orderId: order.orderId });
  if (order) {
    await evaluateAndPersistShipmentOps(order, { source });
  }

  const ops = order ? buildShipmentOpsView(order, { source }) : null;

  return {
    success: true,
    resetApplied,
    snapshot,
    pickupDate: order?.shipmentInfo?.pickupDate || null,
    shipmentOps: ops,
    order
  };
}

/**
 * Quick reset check from webhook payload before upsert.
 * @param {object} payload
 * @param {import('mongoose').Document} order
 */
function detectResetFromWebhookPayload(payload, order) {
  const si = order.shipmentInfo || {};
  const texts = collectForwardOrderTexts(payload, payload);
  const providerStatus =
    payload.current_status ||
    payload.shipment_status ||
    payload.status ||
    payload.current_status_description ||
    null;
  texts.push(String(providerStatus || ''));
  texts.push(String(payload.remark || payload.comment || payload.message || ''));

  return detectForwardOrderReset({
    statusLabel: providerStatus,
    statusMessage: payload.remark || payload.comment || payload.message,
    texts,
    awbCode: payload.awb_code || payload.awb || si.awbCode,
    hadLocalAwb: Boolean(si.awbCode || si.trackingNumber)
  });
}

module.exports = {
  applyLocalShipmentReset,
  buildPayloadFromSnapshot,
  persistPickupDateFromSnapshot,
  reconcileOrderFromShiprocket,
  detectResetFromWebhookPayload,
  detectForwardOrderReset
};
