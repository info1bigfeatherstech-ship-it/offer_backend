/**
 * Unified Shiprocket → Order reconciliation.
 * Shiprocket is the source of truth for carrier status, IDs, pickup, and reset detection.
 */

const Order = require('../models/Order');
const ShiprocketService = require('../utils/shiprocket');
const { evaluateAndPersistShipmentOps, buildShipmentOpsView } = require('./shipmentOps');
const {
  collectForwardOrderTexts,
  detectForwardOrderReset,
  classifyForwardStatusCode,
  isForwardProgressStatus,
  sanitizeTrackingEventsForProvider
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
    shiprocketPickupId: null,
    manifestUrl: null,
    labelUrl: null,
    manifestDownloaded: false,
    labelDownloaded: false,
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
  const hadLocalPickup = Boolean(si.pickupDate || si.pickupScheduledAt);
  const hadLocalManifestOrLabel = Boolean(si.manifestUrl || si.labelUrl);

  const reset = detectForwardOrderReset({
    statusCode: snapshot.statusCode,
    statusLabel: snapshot.providerStatus,
    statusMessage: snapshot.statusMessage,
    texts: snapshot.signalTexts,
    awbCode: snapshot.awbCode,
    hadLocalAwb,
    hadLocalPickup,
    hadLocalManifestOrLabel,
    apiPickupScheduled: snapshot.pickupScheduled === true || Boolean(snapshot.pickupDate),
    apiPickupDate: snapshot.pickupDate || null
  });

  if (
    reset.resetDetected &&
    snapshot.awbCode &&
    isForwardProgressStatus(snapshot.providerStatus, snapshot.statusCode)
  ) {
    reset.resetDetected = false;
    reset.reason = null;
  }

  if (
    !reset.resetDetected &&
    !snapshot.awbCode &&
    (hadLocalAwb ||
      hadLocalPickup ||
      hadLocalManifestOrLabel ||
      snapshot.resetDetected ||
      snapshot.pickupScheduled ||
      snapshot.pickupDate)
  ) {
    reset.resetDetected = true;
    reset.reason =
      snapshot.resetReason ||
      snapshot.statusMessage ||
      reset.reason ||
      'Stale Shiprocket shipment cycle without AWB';
  }

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
        manifestDownloaded: false,
        labelDownloaded: false,
        shiprocketPickupId: null,
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
  if (snapshot.awbCode) {
    const snapAwb = String(snapshot.awbCode).trim();
    // Mirror panel-generated docs only when Shiprocket AWB matches the synced cycle.
    if (snapshot.labelUrl) {
      payload.labelUrl = snapshot.labelUrl;
      payload.fulfillmentLabelAwb = snapAwb;
    }
    if (snapshot.manifestUrl) {
      payload.manifestUrl = snapshot.manifestUrl;
      payload.fulfillmentManifestAwb = snapAwb;
    }
  }
  if (snapshot.providerStatus) payload.providerStatus = snapshot.providerStatus;
  if (snapshot.shiprocketPickupId) {
    payload.shiprocketPickupId = snapshot.shiprocketPickupId;
  }
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
  const hasAwb = Boolean(
    si.awbCode || si.trackingNumber || (snap?.awbCode && String(snap.awbCode).trim())
  );

  if (!hasAwb) {
    if (si.pickupDate || si.pickupScheduledAt || si.shiprocketPickupId) {
      await applyUpsertShipmentInfo({
        order: freshOrder,
        shipmentPayload: {
          pickupDate: null,
          pickupScheduledAt: null,
          shiprocketPickupId: null,
          lastPickupError: null
        },
        trigger: trigger || 'reconcile_clear_stale_pickup_no_awb',
        allowOrderStatusUpdate: false
      });
    }
    return { success: true, pickupDate: null, source: 'no_awb' };
  }

  if (snap && snap.pickupScheduled === false) {
    const localForwardProgress = Boolean(
      si.pickupDate || si.pickupScheduledAt || si.manifestUrl || si.labelUrl
    );
    if (localForwardProgress && hasAwb) {
      return ensureShiprocketPickupId(freshOrder, trigger || 'reconcile_pickup_id_only');
    }
    if (si.pickupDate || si.pickupScheduledAt || si.shiprocketPickupId) {
      await applyUpsertShipmentInfo({
        order: freshOrder,
        shipmentPayload: {
          pickupDate: null,
          pickupScheduledAt: null,
          shiprocketPickupId: null,
          lastPickupError: null
        },
        trigger: trigger || 'reconcile_clear_stale_pickup',
        allowOrderStatusUpdate: false
      });
    }
    return { success: true, pickupDate: null, shiprocketPickupId: null, source: 'not_scheduled' };
  }

  const shouldResolveBatch = Boolean(
    snap?.pickupScheduled === true ||
      snap?.pickupDate ||
      si.pickupDate ||
      si.pickupScheduledAt
  );

  if (!shouldResolveBatch) {
    return {
      success: true,
      pickupDate: si.pickupDate || null,
      shiprocketPickupId: si.shiprocketPickupId || null,
      source: 'none'
    };
  }

  const shipmentId = si.shipmentId || snap?.shipmentId;
  const resolved = await ShiprocketService.resolveAuthoritativePickupDate({
    shipmentId,
    shiprocketOrderId: si.shiprocketOrderId || snap?.shiprocketOrderId,
    channelOrderId: freshOrder.orderId,
    allowPickupListFallback:
      snap?.pickupScheduled === true || Boolean(si.pickupDate || si.pickupScheduledAt)
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

  let pickupId = resolved.shiprocketPickupId || null;
  if (!pickupId) {
    const batchOnly = await ShiprocketService.fetchPickupBatchForShipment({
      shipmentId,
      shiprocketOrderId: si.shiprocketOrderId || snap?.shiprocketOrderId,
      channelOrderId: freshOrder.orderId
    });
    if (batchOnly.success && batchOnly.shiprocketPickupId) {
      pickupId = batchOnly.shiprocketPickupId;
    }
  }

  if (pickupId && pickupId !== si.shiprocketPickupId) {
    payload.shiprocketPickupId = pickupId;
  }

  if (Object.keys(payload).length === 0) {
    return {
      success: resolved.success,
      pickupDate: si.pickupDate || null,
      shiprocketPickupId: si.shiprocketPickupId || null,
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
    shiprocketPickupId: updated?.shipmentInfo?.shiprocketPickupId || payload.shiprocketPickupId || null,
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
          const providerStatus =
            trackingResult.currentStatus || order.shipmentInfo?.providerStatus || null;
          const sanitizedEvents = sanitizeTrackingEventsForProvider(
            trackingResult.events,
            providerStatus
          );
          await applyUpsertShipmentInfo({
            order,
            shipmentPayload: {
              ...trackingResult,
              events: sanitizedEvents,
              providerStatus
            },
            trigger: `${source}_tracking`,
            allowOrderStatusUpdate
          });
        }
      }
    }
  }

  order = await Order.findOne({ orderId: order.orderId });
  if (order && !resetApplied) {
    await ensureShiprocketPickupId(order, `${source}_pickup_id`);
    order = await Order.findOne({ orderId: order.orderId });
  }
  if (order) {
    await evaluateAndPersistShipmentOps(order, { source });
  }

  const ops = order ? buildShipmentOpsView(order, { source }) : null;

  return {
    success: true,
    resetApplied,
    snapshot,
    pickupDate: order?.shipmentInfo?.pickupDate || null,
    shiprocketPickupId: order?.shipmentInfo?.shiprocketPickupId || null,
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

/**
 * Align local pickup fields with Shiprocket before scheduling pickup.
 * Clears stale pickupDate from cancelled/re-shipped cycles when SR still shows AWB / Ready to ship.
 * @param {import('mongoose').Document} order
 * @param {string} [trigger]
 */
async function ensureForwardPickupStateForSchedule(order, trigger) {
  const { applyUpsertShipmentInfo } = require('../controllers/order.controller');
  const { CLASSIFICATION } = require('./shipmentOps/normalizeProviderSignals');
  const si = order?.shipmentInfo || {};
  const lookup = await ShiprocketService.fetchForwardOrderSnapshot({
    shiprocketOrderId: si.shiprocketOrderId,
    channelOrderId: order.orderId
  });
  const snap = lookup.success ? lookup.snapshot : null;
  const forwardClass = classifyForwardStatusCode(snap?.statusCode, snap?.providerStatus);
  const awbOnlyOnShiprocket =
    forwardClass === CLASSIFICATION.AWB_ASSIGNED ||
    /awb\s*assigned|ready\s*to\s*ship/i.test(String(snap?.providerStatus || ''));

  if (snap?.pickupScheduled === true && !awbOnlyOnShiprocket) {
    const pickupDate = snap.pickupDate || null;
    if (pickupDate) {
      await applyUpsertShipmentInfo({
        order,
        shipmentPayload: {
          pickupDate,
          pickupScheduledAt: si.pickupScheduledAt || new Date(),
          lastPickupError: null,
          providerStatus: snap.providerStatus || si.providerStatus
        },
        trigger: trigger || 'pickup_state_sync',
        allowOrderStatusUpdate: false
      });
    }
    return { booked: true, pickupDate, snapshot: snap, cleared: false };
  }

  let freshOrder = await Order.findOne({ orderId: order.orderId });
  if (!freshOrder) return { booked: false, snapshot: snap, cleared: false };

  const fsi = freshOrder.shipmentInfo || {};
  const hasStale = Boolean(
    fsi.pickupDate ||
      fsi.pickupScheduledAt ||
      ShiprocketService.isPickupAlreadyScheduledMessage(fsi.lastPickupError)
  );

  if (hasStale || snap?.pickupScheduled === false || awbOnlyOnShiprocket) {
    await applyUpsertShipmentInfo({
      order: freshOrder,
      shipmentPayload: {
        pickupDate: null,
        pickupScheduledAt: null,
        lastPickupError: null,
        providerSnapshot: snap?.providerSnapshot || fsi.providerSnapshot || null
      },
      trigger: trigger || 'clear_stale_pickup_before_schedule',
      allowOrderStatusUpdate: false
    });
    await evaluateAndPersistShipmentOps(freshOrder, {
      source: trigger || 'clear_stale_pickup_before_schedule'
    });
    return { booked: false, snapshot: snap, cleared: true };
  }

  return { booked: false, snapshot: snap, cleared: false };
}

/**
 * Whether order is eligible for Shiprocket pickup batch id (SRPID) backfill.
 * @param {object|null|undefined} shipmentInfo
 */
function isEligibleForShiprocketPickupIdBackfill(shipmentInfo) {
  const si = shipmentInfo || {};
  if (si.shiprocketPickupId) return false;
  if (!(si.awbCode || si.trackingNumber)) return false;
  return Boolean(si.shipmentId || si.shiprocketOrderId);
}

/**
 * Fetch SRPID from Shiprocket pickup list and persist on order (no full reconcile).
 * @param {import('mongoose').Document|string|object} orderOrId
 * @param {string} [trigger]
 */
async function ensureShiprocketPickupId(orderOrId, trigger = 'pickup_id_backfill') {
  const orderId =
    typeof orderOrId === 'string'
      ? orderOrId.trim()
      : orderOrId?.orderId != null
        ? String(orderOrId.orderId).trim()
        : '';
  if (!orderId) {
    return { success: false, code: 'ORDER_ID_REQUIRED', shiprocketPickupId: null };
  }

  const freshOrder = await Order.findOne({ orderId });
  if (!freshOrder) {
    return { success: false, code: 'ORDER_NOT_FOUND', shiprocketPickupId: null };
  }

  const si = freshOrder.shipmentInfo || {};
  if (si.shiprocketPickupId) {
    return {
      success: true,
      shiprocketPickupId: si.shiprocketPickupId,
      source: 'cached'
    };
  }

  if (!isEligibleForShiprocketPickupIdBackfill(si)) {
    return { success: false, code: 'NOT_ELIGIBLE', shiprocketPickupId: null };
  }

  const lookup = await ShiprocketService.fetchForwardOrderSnapshot({
    shiprocketOrderId: si.shiprocketOrderId,
    channelOrderId: freshOrder.orderId
  });
  if (lookup.success && lookup.snapshot?.shiprocketPickupId) {
    const { applyUpsertShipmentInfo } = require('../controllers/order.controller');
    await applyUpsertShipmentInfo({
      order: freshOrder,
      shipmentPayload: { shiprocketPickupId: lookup.snapshot.shiprocketPickupId },
      trigger: `${trigger}_orders_show`,
      allowOrderStatusUpdate: false
    });
    return {
      success: true,
      shiprocketPickupId: lookup.snapshot.shiprocketPickupId,
      source: 'orders_show'
    };
  }

  const batch = await ShiprocketService.fetchPickupBatchForShipment({
    shipmentId: si.shipmentId,
    shiprocketOrderId: si.shiprocketOrderId,
    channelOrderId: freshOrder.orderId
  });

  if (!batch.success || !batch.shiprocketPickupId) {
    return {
      success: false,
      code: batch.code || 'PICKUP_ID_NOT_FOUND',
      shiprocketPickupId: null,
      message: batch.message || null
    };
  }

  const { applyUpsertShipmentInfo } = require('../controllers/order.controller');
  await applyUpsertShipmentInfo({
    order: freshOrder,
    shipmentPayload: { shiprocketPickupId: batch.shiprocketPickupId },
    trigger,
    allowOrderStatusUpdate: false
  });

  return {
    success: true,
    shiprocketPickupId: batch.shiprocketPickupId,
    source: batch.source || 'pickup_list'
  };
}

/**
 * Best-effort SRPID backfill for orders on the current admin list page.
 * @param {Array<object>} orders — lean order docs (mutated in place when saved)
 * @param {{ max?: number, trigger?: string }} [options]
 */
async function backfillShiprocketPickupIdsForListPage(orders, options = {}) {
  const max = Number.isFinite(Number(options.max)) ? Number(options.max) : 10;
  const trigger = options.trigger || 'admin_list_pickup_id_backfill';
  const candidates = (Array.isArray(orders) ? orders : [])
    .filter((o) => isEligibleForShiprocketPickupIdBackfill(o?.shipmentInfo))
    .slice(0, max);

  let saved = 0;
  for (const doc of candidates) {
    try {
      const result = await ensureShiprocketPickupId(doc, trigger);
      if (result.success && result.shiprocketPickupId) {
        if (!doc.shipmentInfo) doc.shipmentInfo = {};
        doc.shipmentInfo.shiprocketPickupId = result.shiprocketPickupId;
        saved += 1;
      }
    } catch (err) {
      const logger = require('../utils/logger');
      logger.warn('[pickup-id-backfill] list page failed', {
        orderId: doc?.orderId,
        message: err?.message || String(err)
      });
    }
  }
  return { attempted: candidates.length, saved };
}

module.exports = {
  applyLocalShipmentReset,
  buildPayloadFromSnapshot,
  persistPickupDateFromSnapshot,
  reconcileOrderFromShiprocket,
  detectResetFromWebhookPayload,
  detectForwardOrderReset,
  ensureForwardPickupStateForSchedule,
  ensureShiprocketPickupId,
  isEligibleForShiprocketPickupIdBackfill,
  backfillShiprocketPickupIdsForListPage
};
