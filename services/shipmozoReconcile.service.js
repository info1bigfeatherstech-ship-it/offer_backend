/**
 * Shipmozo tracking reconcile for forward + Case-1 courier RTO parity.
 * Does NOT call Shiprocket. Production-safe: single-order AWB track only.
 *
 * Reuses existing RTO gates:
 * - mapProviderStatusToOrderStatus (via upsertShipmentInfo)
 * - persistRtoTrackingInsights (warehouse latch + NDR reason)
 * - notifyRtoInitiated (same customer notifications as Shiprocket webhook path)
 */

const Order = require('../models/Order');
const ShipmozoService = require('../utils/shipmozo');
const logger = require('../utils/logger');
const {
  SHIPPING_PROVIDERS,
  isShipmozoOrder,
  resolveOrderShippingProvider
} = require('../constants/shippingProviders');
const { isRtoProviderStatus } = require('./shipmentOps/shiprocketStatusMap');
const {
  persistRtoTrackingInsights,
  getRtoShippingFromOrder,
  applyRtoFreightChargeToOrder,
  markRtoFreightSyncAttempted,
  orderNeedsRtoFreightSync
} = require('./rtoRefund.service');

function wasRtoish(orderLike) {
  if (!orderLike) return false;
  if (String(orderLike.orderStatus || '').toLowerCase() === 'rto') return true;
  return isRtoProviderStatus(orderLike.shipmentInfo?.providerStatus);
}

function getDefaultRtoShippingChargeInr() {
  const n = Number(process.env.RTO_DEFAULT_SHIPPING_CHARGE || 0);
  return Number.isFinite(n) && n > 0 ? Math.round((n + Number.EPSILON) * 100) / 100 : 0;
}

/**
 * Apply env default reverse freight for Shipmozo (no Shiprocket billing API).
 * Idempotent via orderNeedsRtoFreightSync / mark attempt.
 * @param {import('mongoose').Document|object} order
 * @param {{ persist?: boolean }} [options]
 */
async function syncShipmozoRtoFreightDefault(order, options = {}) {
  if (!order || !isShipmozoOrder(order)) {
    return { updated: false, amountInr: 0, code: 'NOT_SHIPMOZO' };
  }
  if (!orderNeedsRtoFreightSync(order) && options.force !== true) {
    return { updated: false, amountInr: getRtoShippingFromOrder(order), code: 'SKIPPED' };
  }

  const defaultCharge = getDefaultRtoShippingChargeInr();
  let updated = false;
  if (defaultCharge > 0.005) {
    updated = applyRtoFreightChargeToOrder(order, defaultCharge);
  } else {
    markRtoFreightSyncAttempted(order);
  }

  if (options.persist !== false && typeof order.save === 'function') {
    try {
      await order.save();
    } catch (_) {
      /* non-blocking */
    }
  }

  return {
    updated,
    amountInr: updated ? defaultCharge : getRtoShippingFromOrder(order),
    code: updated ? 'ENV_DEFAULT' : 'NO_DEFAULT_CHARGE'
  };
}

/**
 * Pull live Shipmozo track → persist shipment + RTO insights.
 * @param {import('mongoose').Document|object} order
 * @param {{ source?: string, allowOrderStatusUpdate?: boolean, notify?: boolean }} [options]
 */
async function reconcileOrderFromShipmozo(order, options = {}) {
  const source = String(options.source || 'shipmozo_reconcile').trim() || 'shipmozo_reconcile';
  const allowOrderStatusUpdate = options.allowOrderStatusUpdate !== false;
  const notify = options.notify !== false;

  if (!order?.orderId) {
    return { success: false, code: 'ORDER_REQUIRED', message: 'Order is required' };
  }

  if (!isShipmozoOrder(order)) {
    return {
      success: false,
      code: 'NOT_SHIPMOZO_ORDER',
      message: 'Order is not a Shipmozo shipment'
    };
  }

  const awb = String(
    order.shipmentInfo?.awbCode || order.shipmentInfo?.trackingNumber || ''
  ).trim();
  if (!awb) {
    return {
      success: false,
      code: 'SHIPMOZO_AWB_MISSING',
      message: 'No AWB on this Shipmozo order yet'
    };
  }

  const previousProviderStatus = order.shipmentInfo?.providerStatus || null;
  const previousOrderStatus = order.orderStatus || null;
  const previousRto = wasRtoish(order);

  let tracking;
  try {
    tracking = await ShipmozoService.getTrackingByAwb(awb);
  } catch (err) {
    logger.error('[shipmozoReconcile] track failed', {
      orderId: order.orderId,
      message: err.message
    });
    return {
      success: false,
      code: 'SHIPMOZO_TRACK_ERROR',
      message: err.message || 'Shipmozo track failed'
    };
  }

  if (!tracking?.success) {
    return {
      success: false,
      code: 'SHIPMOZO_TRACK_FAILED',
      message: tracking?.message || 'Shipmozo track failed',
      raw: tracking?.raw || null
    };
  }

  const providerStatus =
    tracking.currentStatus || order.shipmentInfo?.providerStatus || null;

  const statusNorm = String(providerStatus || '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ');
  if (
    /\bcancel/.test(statusNorm) ||
    /shipment cancelled|order cancelled|awb cancel/.test(statusNorm)
  ) {
    try {
      const { finalizeShipmentAfterRemoteCancel } = require('../controllers/admin-order-fulfillment.controller');
      // Prefer local reset helper from reconcile/shiprocket path to avoid circular require issues
    } catch (_) {
      /* fall through */
    }
    try {
      const {
        applyLocalShipmentReset
      } = require('./shiprocketReconcile.service');
      const resetOrder = await applyLocalShipmentReset(order, {
        reason: providerStatus || 'Cancelled on Shipmozo',
        trigger: `${source}_shipmozo_cancel_detected`,
        appendEvent: true
      });
      if (resetOrder) {
        try {
          const { evaluateAndPersistShipmentOps } = require('./shipmentOps');
          await evaluateAndPersistShipmentOps(resetOrder, { source: `${source}_shipmozo_cancel` });
        } catch (_) {
          /* non-blocking */
        }
        const freshReset = await Order.findOne({ orderId: order.orderId });
        return {
          success: true,
          cancelled: true,
          message: 'Shipmozo reports this shipment cancelled — local AWB cleared for re-ship.',
          order: freshReset || resetOrder,
          tracking,
          provider: SHIPPING_PROVIDERS.SHIPMOZO
        };
      }
    } catch (cancelErr) {
      logger.warn('[shipmozoReconcile] cancel detect reset failed', {
        orderId: order.orderId,
        message: cancelErr.message
      });
    }
  }

  const { applyUpsertShipmentInfo } = require('../controllers/order.controller');
  await applyUpsertShipmentInfo({
    order,
    shipmentPayload: {
      providerStatus,
      courier: tracking.courier || order.shipmentInfo?.courier,
      estimatedDelivery: tracking.estimatedDelivery || undefined,
      events: Array.isArray(tracking.events) ? tracking.events : [],
      provider: SHIPPING_PROVIDERS.SHIPMOZO,
      awbCode: tracking.awbCode || awb,
      trackingNumber: tracking.awbCode || awb
    },
    trigger: source,
    allowOrderStatusUpdate
  });

  let fresh = await Order.findOne({ orderId: order.orderId });
  if (!fresh) {
    return { success: false, code: 'ORDER_NOT_FOUND_AFTER_UPSERT', message: 'Order missing after upsert' };
  }

  let insightsChanged = false;
  const ps = String(fresh.shipmentInfo?.providerStatus || '');
  const isRtoishNow =
    String(fresh.orderStatus || '').toLowerCase() === 'rto' || isRtoProviderStatus(ps);

  if (isRtoishNow) {
    insightsChanged = persistRtoTrackingInsights(fresh);
    try {
      await syncShipmozoRtoFreightDefault(fresh, { persist: false });
    } catch (_) {
      /* non-blocking */
    }
    if (insightsChanged || fresh.isModified?.('returnInfo') || fresh.isModified?.('shipmentInfo')) {
      try {
        if (typeof fresh.markModified === 'function') {
          fresh.markModified('returnInfo');
          fresh.markModified('shipmentInfo');
        }
        await fresh.save();
      } catch (saveErr) {
        logger.warn('[shipmozoReconcile] RTO insights save failed', {
          orderId: fresh.orderId,
          message: saveErr.message
        });
      }
    }
  }

  try {
    const { evaluateAndPersistShipmentOps } = require('./shipmentOps');
    await evaluateAndPersistShipmentOps(fresh, { source });
    fresh = await Order.findOne({ orderId: order.orderId });
  } catch (_) {
    /* non-blocking ops */
  }

  if (notify && !previousRto && wasRtoish(fresh)) {
    try {
      const { notifyRtoInitiated } = require('./rtoNotification.service');
      await notifyRtoInitiated(fresh);
    } catch (notifyErr) {
      logger.warn('[shipmozoReconcile] RTO notify failed', {
        orderId: fresh.orderId,
        message: notifyErr.message
      });
    }
  }

  return {
    success: true,
    order: fresh,
    provider: SHIPPING_PROVIDERS.SHIPMOZO,
    previousProviderStatus,
    previousOrderStatus,
    currentProviderStatus: fresh?.shipmentInfo?.providerStatus || null,
    currentOrderStatus: fresh?.orderStatus || null,
    warehouseDelivered: Boolean(fresh?.returnInfo?.rtoWarehouseDeliveredAt),
    tracking
  };
}

/**
 * @param {string} orderId
 * @param {string} [source]
 */
async function reconcileShipmozoOrderById(orderId, source = 'shipmozo_reconcile') {
  const id = String(orderId || '').trim();
  if (!id) {
    return { success: false, code: 'ORDER_ID_REQUIRED', message: 'orderId required' };
  }
  const order = await Order.findOne({ orderId: id });
  if (!order) {
    return { success: false, code: 'ORDER_NOT_FOUND', message: 'Order not found' };
  }
  if (resolveOrderShippingProvider(order) !== SHIPPING_PROVIDERS.SHIPMOZO) {
    return { success: false, code: 'NOT_SHIPMOZO_ORDER', message: 'Not a Shipmozo order' };
  }
  return reconcileOrderFromShipmozo(order, { source, notify: true });
}

module.exports = {
  reconcileOrderFromShipmozo,
  reconcileShipmozoOrderById,
  syncShipmozoRtoFreightDefault,
  getDefaultRtoShippingChargeInr,
  wasRtoish
};
