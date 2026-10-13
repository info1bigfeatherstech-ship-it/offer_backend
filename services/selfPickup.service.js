'use strict';

/**
 * Admin self-pickup / warehouse handover.
 * Customer collects from warehouse before courier pickup — no further courier fulfillment.
 *
 * Production rules:
 * - Only pending | confirmed | processing | pickup_exception (pre in-transit)
 * - If Shiprocket/Shipmozo shipment exists → cancel remotely first, then mark delivered
 * - Storefront-agnostic (caller must load order with admin scope)
 * - Does not invent a new orderStatus (uses delivered + fulfillmentMode)
 */

const Order = require('../models/Order');
const ShiprocketService = require('../utils/shiprocket');
const ShipmozoService = require('../utils/shipmozo');
const logger = require('../utils/logger');
const {
  SHIPPING_PROVIDERS,
  isShipmozoOrder
} = require('../constants/shippingProviders');
const { applyLocalShipmentReset } = require('./shiprocketReconcile.service');
const { evaluateAndPersistShipmentOps } = require('./shipmentOps');
const { computeOpsState } = require('./shipmentOps/computeOpsState');
const { OPS_STATES } = require('./shipmentOps/constants');
const { isProviderStatusInTransit } = require('./shipmentOps/shiprocketStatusMap');
const { isUnpaidTerminalOrder } = require('../utils/orderPaymentState');
const { commitOrderStockHold } = require('./orderStockBridge.service');

const SELF_PICKUP_ALLOWED_STATUSES = Object.freeze([
  'pending',
  'confirmed',
  'processing',
  'pickup_exception'
]);

const SELF_PICKUP_BLOCKED_OPS = Object.freeze([
  OPS_STATES.IN_TRANSIT,
  OPS_STATES.OUT_FOR_DELIVERY,
  OPS_STATES.DELIVERED,
  OPS_STATES.RTO,
  OPS_STATES.CANCELLED,
  OPS_STATES.PAYMENT_FAILED
]);

function createError(statusCode, code, message, extras = {}) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  Object.assign(err, extras);
  return err;
}

function hasBookedCourierShipment(order) {
  const si = order?.shipmentInfo || {};
  return Boolean(
    si.awbCode ||
      si.trackingNumber ||
      si.shiprocketOrderId ||
      si.shipmozoOrderId ||
      si.shipmentId
  );
}

/**
 * Whether self-pickup is allowed for this order (pure check).
 * @param {object} order
 * @returns {{ ok: boolean, code?: string, message?: string }}
 */
function evaluateSelfPickupEligibility(order) {
  if (!order) {
    return { ok: false, code: 'ORDER_NOT_FOUND', message: 'Order not found' };
  }

  const storefront = String(order.storefront || 'ecomm').toLowerCase().trim();
  if (storefront === 'dropship') {
    return {
      ok: false,
      code: 'SELF_PICKUP_DROPSHIP_FORBIDDEN',
      message: 'Self pickup is not available for dropshipper orders.'
    };
  }
  if (storefront !== 'ecomm' && storefront !== 'wholesale') {
    return {
      ok: false,
      code: 'SELF_PICKUP_STOREFRONT_FORBIDDEN',
      message: 'Self pickup is only available for ecomm and wholesale orders.'
    };
  }

  if (String(order.fulfillmentMode || '').toLowerCase() === 'self_pickup') {
    return {
      ok: false,
      code: 'ALREADY_SELF_PICKUP',
      message: 'This order is already marked as self pickup.'
    };
  }

  const st = String(order.orderStatus || '').toLowerCase();
  if (!SELF_PICKUP_ALLOWED_STATUSES.includes(st)) {
    return {
      ok: false,
      code: 'SELF_PICKUP_STATUS_BLOCKED',
      message: `Self pickup is only available before courier pickup (status: ${st || 'unknown'}).`
    };
  }

  if (isUnpaidTerminalOrder(order)) {
    return {
      ok: false,
      code: 'ORDER_TERMINAL',
      message: 'Cannot mark self pickup on a cancelled or payment-failed order.'
    };
  }

  const opsState = computeOpsState(order);
  if (SELF_PICKUP_BLOCKED_OPS.includes(opsState)) {
    return {
      ok: false,
      code: 'SELF_PICKUP_OPS_BLOCKED',
      message: `Self pickup not allowed while shipment is ${opsState}.`
    };
  }

  const si = order.shipmentInfo || {};
  if (isProviderStatusInTransit(si.providerStatus)) {
    return {
      ok: false,
      code: 'COURIER_ALREADY_MOVING',
      message:
        'Courier already picked up or is in transit. Self pickup is not allowed — use tracking / RTO flows.'
    };
  }

  return { ok: true, opsState, hasCourierShipment: hasBookedCourierShipment(order) };
}

/**
 * Cancel remote courier booking when present. Throws on hard failure.
 * @param {import('mongoose').Document} order
 */
async function cancelRemoteShipmentIfNeeded(order) {
  if (!hasBookedCourierShipment(order)) {
    return { attempted: false, cancelled: false, provider: null };
  }

  const provider = isShipmozoOrder(order)
    ? SHIPPING_PROVIDERS.SHIPMOZO
    : SHIPPING_PROVIDERS.SHIPROCKET;
  const si = order.shipmentInfo || {};

  let providerCancelOk = false;

  if (provider === SHIPPING_PROVIDERS.SHIPMOZO) {
    // New Order / Pickup Pending often has no AWB yet — still must cancel by order_id.
    const cancel = await ShipmozoService.cancelOrderForShipment(order);
    if (!cancel.success) {
      throw createError(
        502,
        cancel.code || 'PROVIDER_CANCEL_FAILED',
        cancel.message ||
          'Could not cancel shipment on Shipmozo. Cancel on Shipmozo panel, then retry Self pickup.',
        { details: { attempts: cancel.attempts || null, raw: cancel.raw || null }, provider }
      );
    }
    providerCancelOk = true;
    logger.info('[selfPickup] Shipmozo cancel ok', {
      orderId: order.orderId,
      orderIdUsed: cancel.orderIdUsed || null,
      awbUsed: cancel.awbUsed || null
    });
  } else {
    const srOid = si.shiprocketOrderId;
    if (srOid) {
      const cancel = await ShiprocketService.cancelShiprocketOrders([srOid]);
      if (!cancel.success) {
        throw createError(
          502,
          cancel.code || 'PROVIDER_CANCEL_FAILED',
          cancel.message ||
            'Could not cancel shipment on Shiprocket. Cancel on Shiprocket panel, then retry Self pickup.',
          { details: cancel.details || null, provider }
        );
      }
      providerCancelOk = true;
    } else {
      logger.warn('[selfPickup] Shiprocket fields without order id — clearing local shipment only', {
        orderId: order.orderId,
        shipmentId: si.shipmentId || null
      });
    }
  }

  let fresh = await applyLocalShipmentReset(order, {
    reason: 'self_pickup_provider_cancel',
    trigger: 'admin_self_pickup_clear',
    appendEvent: true
  });
  if (fresh) {
    await evaluateAndPersistShipmentOps(fresh, { source: 'admin_self_pickup_cancel' });
  }

  return {
    attempted: true,
    cancelled: providerCancelOk,
    provider,
    order: fresh || order
  };
}

/**
 * @param {object} params
 * @param {import('mongoose').Document} params.order
 * @param {string|null} [params.adminUserId]
 * @param {string} [params.note]
 */
async function markOrderSelfPickup({ order, adminUserId = null, note = '' } = {}) {
  const eligibility = evaluateSelfPickupEligibility(order);
  if (!eligibility.ok) {
    throw createError(409, eligibility.code, eligibility.message);
  }

  const cancelResult = await cancelRemoteShipmentIfNeeded(order);
  const working =
    cancelResult.order && typeof cancelResult.order.save === 'function'
      ? cancelResult.order
      : await Order.findOne({ orderId: order.orderId });

  if (!working) {
    throw createError(404, 'ORDER_NOT_FOUND', 'Order not found after provider cancel');
  }

  // Re-check after cancel (status should still be eligible)
  const again = evaluateSelfPickupEligibility(working);
  if (!again.ok && again.code !== 'ALREADY_SELF_PICKUP') {
    // After local reset, eligibility should still pass; if not, surface clearly
    if (again.code !== 'SELF_PICKUP_STATUS_BLOCKED') {
      throw createError(409, again.code, again.message);
    }
  }

  const now = new Date();
  const noteTrim = String(note || '').trim().slice(0, 500);
  const wasPending = String(working.orderStatus || '').toLowerCase() === 'pending';

  // Pending → delivered skips Confirm; still commit reserved stock (same as approve).
  if (wasPending) {
    try {
      const commitRes = await commitOrderStockHold(working);
      if (!commitRes.ok && !commitRes.skipped) {
        logger.error('[selfPickup] inventory commit failed', {
          orderId: working.orderId,
          result: commitRes
        });
        throw createError(
          409,
          'INVENTORY_COMMIT_FAILED',
          commitRes.message ||
            'Could not commit stock hold for this order. Resolve inventory, then retry Self pickup.'
        );
      }
    } catch (commitErr) {
      if (commitErr.statusCode) throw commitErr;
      logger.error('[selfPickup] inventory commit threw', {
        orderId: working.orderId,
        message: commitErr?.message || String(commitErr)
      });
      throw createError(
        500,
        'INVENTORY_COMMIT_FAILED',
        'Could not commit stock hold for this order. Retry Self pickup shortly.'
      );
    }
  }

  working.fulfillmentMode = 'self_pickup';
  working.orderStatus = 'delivered';
  working.selfPickup = {
    completedAt: now,
    completedBy: adminUserId || null,
    note: noteTrim || null,
    providerCancelled: Boolean(cancelResult.cancelled)
  };

  working.shipmentInfo = working.shipmentInfo || {};
  // Clear courier booking ids so background sync cannot resurrect a cancelled shipment.
  working.shipmentInfo.shiprocketOrderId = null;
  working.shipmentInfo.shipmozoOrderId = null;
  working.shipmentInfo.shipmozoReferenceId = null;
  working.shipmentInfo.shipmentId = null;
  working.shipmentInfo.awbCode = null;
  working.shipmentInfo.trackingNumber = null;
  working.shipmentInfo.courier = null;
  working.shipmentInfo.assignedCourierId = null;
  working.shipmentInfo.pickupDate = null;
  working.shipmentInfo.pickupScheduledAt = null;
  working.shipmentInfo.shiprocketPickupId = null;
  working.shipmentInfo.manifestUrl = null;
  working.shipmentInfo.labelUrl = null;
  working.shipmentInfo.manifestDownloaded = false;
  working.shipmentInfo.labelDownloaded = false;
  // Not a courier ship — clear transit stamps so UI does not show Shipped / OFD.
  working.shipmentInfo.shippedAt = null;
  working.shipmentInfo.outForDeliveryAt = null;
  working.shipmentInfo.deliveredAt = now;
  working.shipmentInfo.providerStatus = 'SELF_PICKUP';
  working.shipmentInfo.lastSyncSource = 'admin_self_pickup';
  working.shipmentInfo.lastSyncAt = now;
  if (typeof working.markModified === 'function') {
    working.markModified('shipmentInfo');
    working.markModified('selfPickup');
  }

  await working.save();
  await evaluateAndPersistShipmentOps(working, { source: 'admin_self_pickup' });

  const fresh = await Order.findOne({ orderId: working.orderId });
  logger.info('[selfPickup] marked', {
    orderId: working.orderId,
    storefront: working.storefront || 'ecomm',
    providerCancelled: Boolean(cancelResult.cancelled),
    provider: cancelResult.provider || null,
    adminUserId: adminUserId ? String(adminUserId) : null
  });

  return {
    order: fresh || working,
    providerCancelled: Boolean(cancelResult.cancelled),
    provider: cancelResult.provider || null
  };
}

module.exports = {
  evaluateSelfPickupEligibility,
  hasBookedCourierShipment,
  markOrderSelfPickup,
  SELF_PICKUP_ALLOWED_STATUSES
};
