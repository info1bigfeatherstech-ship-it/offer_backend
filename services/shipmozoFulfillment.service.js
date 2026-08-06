/**
 * Shipmozo Ship Now — assign quoted checkout courier first.
 * If quoted courier fails / unavailable, return QUOTED_COURIER_UNAVAILABLE
 * unless confirmSubstitute=true or an explicit courierId override is provided.
 */

const Order = require('../models/Order');
const ShipmozoService = require('../utils/shipmozo');
const logger = require('../utils/logger');
const { SHIPPING_PROVIDERS } = require('../constants/shippingProviders');

function quotedCourierFromOrder(order) {
  const snap = order?.shippingSnapshot || {};
  const fromSnap =
    snap.shipmozoCourierId != null && Number.isFinite(Number(snap.shipmozoCourierId))
      ? Number(snap.shipmozoCourierId)
      : snap.courierCompanyId != null && Number.isFinite(Number(snap.courierCompanyId))
        ? Number(snap.courierCompanyId)
        : null;
  const fromAssigned =
    order?.shipmentInfo?.assignedCourierId != null &&
    Number.isFinite(Number(order.shipmentInfo.assignedCourierId))
      ? Number(order.shipmentInfo.assignedCourierId)
      : null;
  return {
    courierId: fromSnap || fromAssigned,
    courierName: String(snap.courierName || '').trim() || null,
    pickupsAutomaticallyScheduled:
      snap.pickupsAutomaticallyScheduled != null
        ? Boolean(snap.pickupsAutomaticallyScheduled)
        : null
  };
}

/**
 * @param {import('mongoose').Document} order
 * @param {object} opts
 * @param {number|null} [opts.courierIdOverride]
 * @param {boolean} [opts.confirmSubstitute] — admin confirmed cheapest/other courier
 * @param {function} opts.applyUpsertShipmentInfo
 * @param {function} [opts.evaluateAndPersistShipmentOps]
 */
async function runShipmozoAssignShip(order, opts = {}) {
  const {
    courierIdOverride = null,
    confirmSubstitute = false,
    applyUpsertShipmentInfo,
    evaluateAndPersistShipmentOps
  } = opts;

  if (!order) {
    return { success: false, code: 'ORDER_REQUIRED', message: 'Order is required.' };
  }

  if (order.shipmentInfo?.awbCode || order.shipmentInfo?.trackingNumber) {
    return { success: false, code: 'AWB_ALREADY_ASSIGNED', message: 'AWB already assigned for this order.' };
  }

  const smOrderId =
    String(order.shipmentInfo?.shipmozoOrderId || order.shipmentInfo?.shipmentId || order.orderId).trim();
  if (!smOrderId) {
    return {
      success: false,
      code: 'SHIPMENT_ID_MISSING',
      message: 'Push order to Shipmozo first (missing shipmozo order id).'
    };
  }

  const quoted = quotedCourierFromOrder(order);
  let targetCourierId =
    courierIdOverride != null && Number.isFinite(Number(courierIdOverride))
      ? Number(courierIdOverride)
      : quoted.courierId;
  let substituted = false;
  let substituteMeta = null;
  let cheapestFallback = null;

  // Load live rates for availability + cheapest fallback
  let rates;
  try {
    rates = await ShipmozoService.listCouriersForOrder(order);
  } catch (err) {
    logger.error('[Shipmozo] listCouriersForOrder failed', { message: err.message, orderId: order.orderId });
    rates = { ok: false, couriers: [], message: err.message };
  }

  const available = Array.isArray(rates?.couriers) ? rates.couriers : [];
  const cheapest = ShipmozoService.pickCheapestCourier(available, {
    codRequired: String(order.paymentInfo?.method || '').toLowerCase() === 'cod'
  });
  if (cheapest) {
    cheapestFallback = {
      courierId: cheapest.courierId,
      courierName: cheapest.courierName,
      totalCharges: cheapest.totalCharges,
      estimatedDays: cheapest.estimatedDays
    };
  }

  const quotedStillAvailable =
    targetCourierId != null &&
    available.some((c) => Number(c.courierId) === Number(targetCourierId));

  // No override: prefer quoted; if unavailable require admin confirm
  if (courierIdOverride == null) {
    if (quoted.courierId != null && !quotedStillAvailable) {
      if (!confirmSubstitute) {
        return {
          success: false,
          code: 'QUOTED_COURIER_UNAVAILABLE',
          message: `Checkout courier "${quoted.courierName || quoted.courierId}" is not available on Shipmozo right now. Confirm to assign the cheapest available courier, pick another courier, or assign from the Shipmozo panel.`,
          quotedCourier: {
            courierId: quoted.courierId,
            courierName: quoted.courierName
          },
          suggestedCourier: cheapestFallback,
          availableCouriers: available.slice(0, 15).map((c) => ({
            courierId: c.courierId,
            courierName: c.courierName,
            totalCharges: c.totalCharges,
            estimatedDays: c.estimatedDays
          }))
        };
      }
      if (!cheapestFallback) {
        return {
          success: false,
          code: 'NO_ACTIVE_COURIER',
          message:
            'Quoted courier unavailable and no alternative Shipmozo courier found. Assign from Shipmozo panel or retry later.'
        };
      }
      targetCourierId = cheapestFallback.courierId;
      substituted = true;
      substituteMeta = {
        courierAssignNote: `Quoted courier ${quoted.courierName || quoted.courierId} unavailable; assigned cheapest ${cheapestFallback.courierName || cheapestFallback.courierId} after admin confirm.`,
        courierSubstitutedFromId: quoted.courierId,
        courierSubstitutedFromName: quoted.courierName
      };
    } else if (quoted.courierId == null) {
      if (!confirmSubstitute && !cheapestFallback) {
        return {
          success: false,
          code: 'NO_QUOTED_COURIER',
          message: 'No checkout courier on this order and no Shipmozo rates available.'
        };
      }
      if (quoted.courierId == null && !confirmSubstitute) {
        return {
          success: false,
          code: 'QUOTED_COURIER_UNAVAILABLE',
          message:
            'No checkout courier was stored on this order. Confirm to assign the cheapest Shipmozo courier, or pass courierId.',
          quotedCourier: null,
          suggestedCourier: cheapestFallback,
          availableCouriers: available.slice(0, 15).map((c) => ({
            courierId: c.courierId,
            courierName: c.courierName,
            totalCharges: c.totalCharges,
            estimatedDays: c.estimatedDays
          }))
        };
      }
      if (!targetCourierId && cheapestFallback) {
        targetCourierId = cheapestFallback.courierId;
        substituted = true;
        substituteMeta = {
          courierAssignNote: `No quoted courier; assigned cheapest ${cheapestFallback.courierName} after admin confirm.`,
          courierSubstitutedFromId: null,
          courierSubstitutedFromName: null
        };
      }
    }
  }

  if (targetCourierId == null || !Number.isFinite(Number(targetCourierId))) {
    return {
      success: false,
      code: 'COURIER_ID_REQUIRED',
      message: 'courierId is required to assign on Shipmozo.'
    };
  }

  const assign = await ShipmozoService.assignCourier({
    orderId: smOrderId,
    courierId: Number(targetCourierId)
  });

  if (!assign.success) {
    // Quoted assign failed — offer substitute unless already substituting / override
    if (courierIdOverride == null && !confirmSubstitute && quoted.courierId != null) {
      return {
        success: false,
        code: 'QUOTED_COURIER_UNAVAILABLE',
        message:
          assign.message ||
          `Could not assign checkout courier. Confirm cheapest alternative or pick another courier.`,
        quotedCourier: {
          courierId: quoted.courierId,
          courierName: quoted.courierName
        },
        suggestedCourier: cheapestFallback,
        availableCouriers: available.slice(0, 15).map((c) => ({
          courierId: c.courierId,
          courierName: c.courierName,
          totalCharges: c.totalCharges,
          estimatedDays: c.estimatedDays
        })),
        details: assign.raw || null
      };
    }
    return {
      success: false,
      code: assign.code || 'ASSIGN_COURIER_FAILED',
      message: assign.message || 'Shipmozo assign-courier failed',
      details: assign.raw || null
    };
  }

  let awbCode = assign.awbCode || assign.trackingNumber || null;
  let courierName =
    assign.courier ||
    (available.find((c) => Number(c.courierId) === Number(targetCourierId)) || {}).courierName ||
    quoted.courierName ||
    null;
  let needsManualPickup = quoted.pickupsAutomaticallyScheduled === false;
  const matchedRate = available.find((c) => Number(c.courierId) === Number(targetCourierId));
  if (matchedRate && matchedRate.pickupsAutomaticallyScheduled === false) {
    needsManualPickup = true;
  }

  // Schedule pickup when required and AWB still missing (or always when manual flag)
  if ((!awbCode || needsManualPickup) && needsManualPickup !== false) {
    // If we know auto-pickup is NO, or we have no AWB yet, try schedule-pickup
    const shouldSchedule = needsManualPickup === true || !awbCode;
    if (shouldSchedule) {
      const pickup = await ShipmozoService.schedulePickup({ orderId: smOrderId });
      if (pickup.success) {
        awbCode = pickup.awbCode || pickup.trackingNumber || awbCode;
        courierName = pickup.courier || courierName;
        needsManualPickup = false;
      } else if (!awbCode) {
        // Keep assignment but surface pickup error — admin can retry schedule
        logger.warn('[Shipmozo] schedule-pickup after assign failed', {
          orderId: order.orderId,
          message: pickup.message
        });
      }
    }
  }

  // If still no AWB but assign succeeded, try schedule-pickup once as fallback
  if (!awbCode) {
    const pickup = await ShipmozoService.schedulePickup({ orderId: smOrderId });
    if (pickup.success) {
      awbCode = pickup.awbCode || pickup.trackingNumber || null;
      courierName = pickup.courier || courierName;
    }
  }

  let labelUrl = null;
  if (awbCode) {
    try {
      const label = await ShipmozoService.getOrderLabel(awbCode);
      if (label.success && label.labelUrl) {
        labelUrl = label.labelUrl;
      }
    } catch (err) {
      logger.warn('[Shipmozo] getOrderLabel failed after assign', {
        orderId: order.orderId,
        message: err.message
      });
    }
  }

  await applyUpsertShipmentInfo({
    order,
    shipmentPayload: {
      shipmentId: order.shipmentInfo?.shipmentId || smOrderId,
      shipmozoOrderId: order.shipmentInfo?.shipmozoOrderId || smOrderId,
      shipmozoReferenceId: order.shipmentInfo?.shipmozoReferenceId || smOrderId,
      provider: SHIPPING_PROVIDERS.SHIPMOZO,
      awbCode: awbCode || null,
      trackingNumber: awbCode || null,
      courier: courierName,
      assignedCourierId: String(targetCourierId),
      labelUrl: labelUrl || undefined,
      providerStatus: awbCode ? 'AWB_ASSIGNED' : 'COURIER_ASSIGNED',
      shipmozoNeedsManualPickup: needsManualPickup === true,
      pickupScheduledAt: awbCode && needsManualPickup !== true ? new Date() : undefined,
      pickupDate:
        awbCode && needsManualPickup !== true
          ? new Date().toISOString().slice(0, 10)
          : undefined,
      events: [],
      ...(substituted && substituteMeta ? substituteMeta : {
        courierAssignNote: null,
        courierSubstitutedFromId: null,
        courierSubstitutedFromName: null
      })
    },
    trigger: 'admin_shipmozo_assign',
    allowOrderStatusUpdate: Boolean(awbCode)
  });

  let fresh = await Order.findOne({ orderId: order.orderId });
  if (fresh && awbCode) {
    const st = String(fresh.orderStatus || '').toLowerCase();
    if (['pending', 'confirmed'].includes(st)) {
      fresh.orderStatus = 'processing';
      fresh.markModified('orderStatus');
      await fresh.save();
      fresh = await Order.findOne({ orderId: order.orderId });
    }
  }

  if (fresh && typeof evaluateAndPersistShipmentOps === 'function') {
    try {
      await evaluateAndPersistShipmentOps(fresh, { source: 'admin_shipmozo_assign' });
    } catch (_) {
      /* non-fatal */
    }
  }

  if (!awbCode) {
    return {
      success: true,
      pendingAwb: true,
      message:
        'Courier assigned on Shipmozo but AWB not returned yet. Use Schedule pickup / sync, or complete from Shipmozo panel.',
      courierId: targetCourierId,
      order: fresh,
      provider: SHIPPING_PROVIDERS.SHIPMOZO
    };
  }

  return {
    success: true,
    message: substituted
      ? 'AWB assigned with substitute courier (admin confirmed).'
      : 'AWB assigned with checkout courier.',
    courierId: targetCourierId,
    shipment: {
      awbCode,
      trackingNumber: awbCode,
      courier: courierName,
      labelUrl
    },
    order: fresh,
    provider: SHIPPING_PROVIDERS.SHIPMOZO,
    substituted
  };
}

module.exports = {
  runShipmozoAssignShip,
  quotedCourierFromOrder
};
