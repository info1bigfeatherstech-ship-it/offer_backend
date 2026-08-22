/**
 * Shipmozo Ship Now — production flow:
 * 1) Prefer checkout quoted courier via assign-courier (Shipmozo source of truth)
 * 2) Do NOT block on a secondary rate-calculator pre-check (can be empty/mismatched
 *    while the courier is still bookable on the pushed order in Shipmozo panel)
 * 3) On assign failure → load rates for substitute suggestions (≤ quoted freight preferred)
 * 4) confirmSubstitute / courierId override → assign chosen alternative
 *
 * Shiprocket orders never enter this module (caller routes by isShipmozoOrder).
 */

const Order = require('../models/Order');
const ShipmozoService = require('../utils/shipmozo');
const logger = require('../utils/logger');
const { SHIPPING_PROVIDERS } = require('../constants/shippingProviders');
const {
  isShipmozoPanelBooked,
  syncShipmentFromShipmozo
} = require('./shipmozoPanelSync.service');

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

function quotedFreightInr(order) {
  const snap = order?.shippingSnapshot || {};
  const n = Number(
    snap.freightInr != null
      ? snap.freightInr
      : snap.deliveryCharges != null
        ? snap.deliveryCharges
        : snap.shippingCharges
  );
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function isCodOrder(order) {
  return String(order?.paymentInfo?.method || order?.paymentMethod || '')
    .toLowerCase()
    .trim() === 'cod';
}

function mapCourierPublic(c) {
  return {
    courierId: c.courierId,
    courierName: c.courierName,
    totalCharges: c.totalCharges,
    estimatedDays: c.estimatedDays
  };
}

/**
 * Prefer cheapest courier with totalCharges <= maxCharge; else overall cheapest.
 */
function pickSubstituteCourier(available, { codRequired = false, maxCharge = null } = {}) {
  const list = Array.isArray(available) ? available : [];
  let pool = list.filter((c) => c.courierId != null && Number.isFinite(c.totalCharges));
  if (codRequired) {
    const codPool = pool.filter((c) => c.codAvailable !== false);
    if (codPool.length) pool = codPool;
  }
  if (!pool.length) return null;

  if (maxCharge != null && Number.isFinite(Number(maxCharge))) {
    const cap = Number(maxCharge) + 0.05;
    const under = pool.filter((c) => Number(c.totalCharges) <= cap);
    if (under.length) {
      under.sort((a, b) => a.totalCharges - b.totalCharges);
      return under[0];
    }
  }

  pool.sort((a, b) => a.totalCharges - b.totalCharges);
  return pool[0];
}

function resolveShipmozoAssignOrderId(order) {
  // Prefer IDs Shipmozo knows from push-order; our marketplace orderId is what we pushed as order_id.
  const si = order?.shipmentInfo || {};
  return String(
    si.shipmozoOrderId || order?.orderId || si.shipmentId || si.shipmozoReferenceId || ''
  ).trim();
}

async function loadLiveRatesSafe(order) {
  try {
    const rates = await ShipmozoService.listCouriersForOrder(order);
    const couriers = Array.isArray(rates?.couriers) ? rates.couriers : [];
    if (!couriers.length) {
      logger.warn('[Shipmozo] listCouriersForOrder returned no couriers', {
        orderId: order?.orderId,
        ok: rates?.ok,
        message: rates?.message || null,
        paymentHint: rates?.paymentType || null,
        weightGrams: rates?.weightGrams || null
      });
    }
    return {
      ok: Boolean(rates?.ok),
      couriers,
      message: rates?.message || null,
      raw: rates?.raw || null
    };
  } catch (err) {
    logger.error('[Shipmozo] listCouriersForOrder threw', {
      orderId: order?.orderId,
      message: err.message,
      stack: err.stack
    });
    return { ok: false, couriers: [], message: err.message || 'Rate lookup failed', raw: null };
  }
}

/**
 * Shipmozo assign-courier often fails when courier was already booked on their panel.
 * @param {string|null|undefined} message
 */
function isShipmozoAlreadyBookedAssignError(message) {
  const m = String(message || '').toLowerCase();
  if (!m) return false;
  return (
    /already\s*(assigned|booked|scheduled)|courier\s*already|pickup\s*already|order\s*already/.test(m) ||
    /invalid\s*order|wrong\s*order|order\s*id\s*(is\s*)?(wrong|invalid|not\s*found)/.test(m) ||
    /\bscheduled\b/.test(m)
  );
}

/**
 * Pull AWB/status from Shipmozo panel instead of re-assigning courier.
 * @param {import('mongoose').Document} order
 * @param {{ evaluateAndPersistShipmentOps?: function }} [opts]
 */
async function syncFromPanelInsteadOfAssign(order, opts = {}) {
  const syncResult = await syncShipmentFromShipmozo(order, {
    source: 'admin_shipmozo_panel_already_booked',
    allowOrderStatusUpdate: true,
    notify: false
  });

  if (!syncResult.success) {
    return {
      success: false,
      code: syncResult.code || 'SHIPMOZO_PANEL_SYNC_FAILED',
      message:
        syncResult.message ||
        'Courier appears booked on Shipmozo already. Refresh Shipmozo sync failed — try again from admin.',
      details: syncResult
    };
  }

  const fresh = syncResult.order || (await Order.findOne({ orderId: order.orderId })) || order;
  const hasAwb = Boolean(
    String(fresh.shipmentInfo?.awbCode || fresh.shipmentInfo?.trackingNumber || '').trim()
  );

  if (opts.evaluateAndPersistShipmentOps) {
    try {
      await opts.evaluateAndPersistShipmentOps(fresh, { source: 'shipmozo_panel_sync_instead_of_assign' });
    } catch (_) {
      /* non-blocking */
    }
  }

  return {
    success: true,
    code: syncResult.partial ? 'SHIPMOZO_PANEL_BOOKED_AWB_PENDING' : 'SHIPMOZO_PANEL_SYNCED',
    message:
      syncResult.message ||
      (hasAwb
        ? 'Courier was already booked on Shipmozo — synced AWB and tracking.'
        : 'Courier already booked on Shipmozo — status synced. Refresh again shortly for AWB.'),
    order: fresh,
    shipment: fresh.shipmentInfo || null,
    panelSynced: true,
    partial: Boolean(syncResult.partial),
    tracking: syncResult.tracking || null
  };
}

/**
 * @param {import('mongoose').Document} order
 * @param {object} opts
 * @param {number|null} [opts.courierIdOverride]
 * @param {boolean} [opts.confirmSubstitute]
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

  try {
    if (!order) {
      return { success: false, code: 'ORDER_REQUIRED', message: 'Order is required.' };
    }

    if (order.shipmentInfo?.awbCode || order.shipmentInfo?.trackingNumber) {
      return {
        success: false,
        code: 'AWB_ALREADY_ASSIGNED',
        message: 'AWB already assigned for this order.'
      };
    }

    const smOrderId = resolveShipmozoAssignOrderId(order);
    if (!smOrderId) {
      return {
        success: false,
        code: 'SHIPMENT_ID_MISSING',
        message: 'Push order to Shipmozo first (missing shipmozo order id).'
      };
    }

    if (isShipmozoPanelBooked(order.shipmentInfo)) {
      logger.info('[Shipmozo] Ship now skipped — panel already booked; syncing instead', {
        orderId: order.orderId,
        smOrderId,
        providerStatus: order.shipmentInfo?.providerStatus || null
      });
      return syncFromPanelInsteadOfAssign(order, { evaluateAndPersistShipmentOps });
    }

    const quoted = quotedCourierFromOrder(order);
    const freightCap = quotedFreightInr(order);
    const codRequired = isCodOrder(order);
    const hasOverride =
      courierIdOverride != null && Number.isFinite(Number(courierIdOverride));

    let available = [];
    let ratesLoaded = false;

    const ensureRates = async () => {
      if (ratesLoaded) return available;
      const rates = await loadLiveRatesSafe(order);
      available = rates.couriers;
      ratesLoaded = true;
      return available;
    };

    const suggestedFromRates = () => {
      const picked = pickSubstituteCourier(available, {
        codRequired,
        maxCharge: freightCap
      });
      if (!picked) return null;
      return {
        courierId: picked.courierId,
        courierName: picked.courierName,
        totalCharges: picked.totalCharges,
        estimatedDays: picked.estimatedDays
      };
    };

    let targetCourierId = hasOverride ? Number(courierIdOverride) : null;
    let substituted = false;
    let substituteMeta = null;

    // ── Path: no override — try checkout courier FIRST (do not rate-gate) ──
    if (!hasOverride && quoted.courierId != null && !confirmSubstitute) {
      logger.info('[Shipmozo] Ship now: assign quoted courier first', {
        orderId: order.orderId,
        smOrderId,
        quotedCourierId: quoted.courierId,
        quotedCourierName: quoted.courierName
      });

      const direct = await ShipmozoService.assignCourier({
        orderId: smOrderId,
        courierId: Number(quoted.courierId)
      });

      if (direct.success) {
        return finalizeShipmozoAssign({
          order,
          smOrderId,
          targetCourierId: Number(quoted.courierId),
          quoted,
          available: [],
          assign: direct,
          substituted: false,
          substituteMeta: null,
          applyUpsertShipmentInfo,
          evaluateAndPersistShipmentOps
        });
      }

      if (isShipmozoAlreadyBookedAssignError(direct.message)) {
        logger.info('[Shipmozo] Quoted assign failed — panel likely booked; syncing', {
          orderId: order.orderId,
          smOrderId,
          assignMessage: direct.message
        });
        return syncFromPanelInsteadOfAssign(order, { evaluateAndPersistShipmentOps });
      }

      // Assign failed — load rates only to suggest alternatives (never claim "unavailable"
      // solely because our rate list was empty before trying assign).
      await ensureRates();
      const suggested = suggestedFromRates();

      logger.warn('[Shipmozo] Quoted assign failed; offering substitute', {
        orderId: order.orderId,
        quotedCourierId: quoted.courierId,
        assignMessage: direct.message,
        rateCount: available.length,
        suggestedCourierId: suggested?.courierId || null
      });

      return {
        success: false,
        code: 'QUOTED_COURIER_UNAVAILABLE',
        message:
          direct.message ||
          `Could not assign checkout courier "${quoted.courierName || quoted.courierId}". Confirm a substitute courier, or assign from the Shipmozo panel.`,
        quotedCourier: {
          courierId: quoted.courierId,
          courierName: quoted.courierName
        },
        suggestedCourier: suggested,
        availableCouriers: available.slice(0, 15).map(mapCourierPublic),
        details: direct.raw || null
      };
    }

    // ── Path: admin confirmed substitute / no quoted / override ─────────────
    if (!hasOverride) {
      await ensureRates();
      const suggested = suggestedFromRates();

      if (quoted.courierId == null && !confirmSubstitute) {
        if (!suggested) {
          // Last resort: nothing to suggest — ask admin to confirm retry / panel
          return {
            success: false,
            code: 'NO_QUOTED_COURIER',
            message:
              'No checkout courier on this order and no Shipmozo rates returned. Retry shortly or assign from the Shipmozo panel.',
            quotedCourier: null,
            suggestedCourier: null,
            availableCouriers: []
          };
        }
        return {
          success: false,
          code: 'QUOTED_COURIER_UNAVAILABLE',
          message:
            'No checkout courier was stored on this order. Confirm to assign the cheapest available Shipmozo courier, or pass courierId.',
          quotedCourier: null,
          suggestedCourier: suggested,
          availableCouriers: available.slice(0, 15).map(mapCourierPublic)
        };
      }

      if (confirmSubstitute) {
        if (suggested) {
          targetCourierId = Number(suggested.courierId);
          substituted = true;
          substituteMeta = {
            courierAssignNote: quoted.courierId
              ? `Quoted courier ${quoted.courierName || quoted.courierId} could not be assigned; assigned ${suggested.courierName || suggested.courierId} after admin confirm.`
              : `No quoted courier; assigned ${suggested.courierName || suggested.courierId} after admin confirm.`,
            courierSubstitutedFromId: quoted.courierId,
            courierSubstitutedFromName: quoted.courierName
          };
        } else if (quoted.courierId != null) {
          // Rates empty but admin confirmed — retry quoted assign (panel may still accept)
          logger.info('[Shipmozo] confirmSubstitute with empty rates — retry quoted assign', {
            orderId: order.orderId,
            quotedCourierId: quoted.courierId
          });
          targetCourierId = Number(quoted.courierId);
        } else {
          return {
            success: false,
            code: 'NO_ACTIVE_COURIER',
            message:
              'No Shipmozo courier rates available to suggest a substitute. Retry later or assign from the Shipmozo panel.',
            quotedCourier: quoted.courierId
              ? { courierId: quoted.courierId, courierName: quoted.courierName }
              : null,
            suggestedCourier: null,
            availableCouriers: []
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

    if (hasOverride && quoted.courierId != null && Number(targetCourierId) !== Number(quoted.courierId)) {
      substituted = true;
      substituteMeta = {
        courierAssignNote: `Assigned courier ${targetCourierId} (override); checkout quote was ${quoted.courierName || quoted.courierId}.`,
        courierSubstitutedFromId: quoted.courierId,
        courierSubstitutedFromName: quoted.courierName
      };
    }

    logger.info('[Shipmozo] Ship now: assign target courier', {
      orderId: order.orderId,
      smOrderId,
      targetCourierId,
      substituted,
      hasOverride,
      confirmSubstitute
    });

    const assign = await ShipmozoService.assignCourier({
      orderId: smOrderId,
      courierId: Number(targetCourierId)
    });

    if (!assign.success) {
      if (isShipmozoAlreadyBookedAssignError(assign.message)) {
        logger.info('[Shipmozo] Assign failed — panel likely booked; syncing', {
          orderId: order.orderId,
          smOrderId,
          assignMessage: assign.message
        });
        return syncFromPanelInsteadOfAssign(order, { evaluateAndPersistShipmentOps });
      }
      if (!ratesLoaded) await ensureRates();
      // If override/substitute failed, surface clearly (do not infinite-loop confirm)
      if (!hasOverride && !confirmSubstitute && quoted.courierId != null) {
        return {
          success: false,
          code: 'QUOTED_COURIER_UNAVAILABLE',
          message:
            assign.message ||
            'Could not assign checkout courier. Confirm a substitute or assign from the Shipmozo panel.',
          quotedCourier: {
            courierId: quoted.courierId,
            courierName: quoted.courierName
          },
          suggestedCourier: suggestedFromRates(),
          availableCouriers: available.slice(0, 15).map(mapCourierPublic),
          details: assign.raw || null
        };
      }
      return {
        success: false,
        code: assign.code || 'ASSIGN_COURIER_FAILED',
        message: assign.message || 'Shipmozo assign-courier failed',
        details: assign.raw || null,
        suggestedCourier: suggestedFromRates(),
        availableCouriers: available.slice(0, 15).map(mapCourierPublic)
      };
    }

    if (!ratesLoaded) {
      // Best-effort rates for courier name / pickup flags (non-blocking)
      try {
        await ensureRates();
      } catch (_) {
        /* ignore */
      }
    }

    return finalizeShipmozoAssign({
      order,
      smOrderId,
      targetCourierId: Number(targetCourierId),
      quoted,
      available,
      assign,
      substituted,
      substituteMeta,
      applyUpsertShipmentInfo,
      evaluateAndPersistShipmentOps
    });
  } catch (err) {
    logger.error('[Shipmozo] runShipmozoAssignShip unexpected error', {
      orderId: order?.orderId,
      message: err.message,
      stack: err.stack
    });
    return {
      success: false,
      code: 'ASSIGN_INTERNAL_ERROR',
      message: err.message || 'Unexpected error while assigning Shipmozo courier.'
    };
  }
}

async function finalizeShipmozoAssign({
  order,
  smOrderId,
  targetCourierId,
  quoted,
  available,
  assign,
  substituted,
  substituteMeta,
  applyUpsertShipmentInfo,
  evaluateAndPersistShipmentOps
}) {
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

  try {
    if ((!awbCode || needsManualPickup) && needsManualPickup !== false) {
      const shouldSchedule = needsManualPickup === true || !awbCode;
      if (shouldSchedule) {
        const pickup = await ShipmozoService.schedulePickup({ orderId: smOrderId });
        if (pickup.success) {
          awbCode = pickup.awbCode || pickup.trackingNumber || awbCode;
          courierName = pickup.courier || courierName;
          needsManualPickup = false;
        } else if (!awbCode) {
          logger.warn('[Shipmozo] schedule-pickup after assign failed', {
            orderId: order.orderId,
            message: pickup.message
          });
        }
      }
    }

    if (!awbCode) {
      const pickup = await ShipmozoService.schedulePickup({ orderId: smOrderId });
      if (pickup.success) {
        awbCode = pickup.awbCode || pickup.trackingNumber || null;
        courierName = pickup.courier || courierName;
      }
    }
  } catch (pickupErr) {
    logger.warn('[Shipmozo] pickup step after assign threw', {
      orderId: order.orderId,
      message: pickupErr.message
    });
  }

  // Do NOT fetch/store Shipmozo label bytes in Mongo (API returns huge base64 PNGs).
  // Admin Open/Download always pulls live from Shipmozo get-order-label.

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
      providerStatus: awbCode ? 'AWB_ASSIGNED' : 'COURIER_ASSIGNED',
      shipmozoNeedsManualPickup: needsManualPickup === true,
      pickupScheduledAt: awbCode && needsManualPickup !== true ? new Date() : undefined,
      pickupDate:
        awbCode && needsManualPickup !== true
          ? new Date().toISOString().slice(0, 10)
          : undefined,
      events: [],
      ...(substituted && substituteMeta
        ? substituteMeta
        : {
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
      provider: SHIPPING_PROVIDERS.SHIPMOZO,
      substituted: Boolean(substituted)
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
      courier: courierName
    },
    order: fresh,
    provider: SHIPPING_PROVIDERS.SHIPMOZO,
    substituted: Boolean(substituted)
  };
}

module.exports = {
  runShipmozoAssignShip,
  quotedCourierFromOrder,
  pickSubstituteCourier
};
