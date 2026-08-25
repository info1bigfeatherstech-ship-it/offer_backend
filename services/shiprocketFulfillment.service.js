/**
 * Shiprocket Ship Now — production fulfillment policy:
 * 1) Prefer checkout quoted courier via assign/awb (do not rate-gate before assign)
 * 2) On assign failure (non-wallet) → live serviceability → suggest substitute
 *    preferring rate ≤ customer-paid freight (COD-capable when COD)
 * 3) confirmSubstitute / courierId → assign chosen alternative after admin confirm
 * 4) NEVER mutate customer order totals / deliveryCharges / payment bill
 *
 * Shipmozo orders never enter this module (caller routes by isShipmozoOrder).
 */

const ShiprocketService = require('../utils/shiprocket');
const logger = require('../utils/logger');
const {
  isCourierInactive,
  pickCheapestActiveCourier,
  getCourierCompanyIdFromRow,
  getCourierNameFromRow,
  buildCourierSubstituteNote
} = require('./courierPolicy.service');

function round2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return Math.round(x * 100) / 100;
}

function quotedCourierFromOrder(order) {
  const snap = order?.shippingSnapshot || {};
  const fromSnap =
    snap.courierCompanyId != null && Number.isFinite(Number(snap.courierCompanyId)) && Number(snap.courierCompanyId) > 0
      ? Number(snap.courierCompanyId)
      : null;
  const fromAssigned =
    order?.shipmentInfo?.assignedCourierId != null &&
    Number.isFinite(Number(order.shipmentInfo.assignedCourierId)) &&
    Number(order.shipmentInfo.assignedCourierId) > 0
      ? Number(order.shipmentInfo.assignedCourierId)
      : null;
  return {
    courierId: fromSnap || fromAssigned,
    courierName: String(snap.courierName || '').trim() || null
  };
}

/**
 * Customer-paid shipping reference for margin guardrails only — not for rewriting bills.
 */
function quotedFreightInr(order) {
  const snap = order?.shippingSnapshot || {};
  const n = Number(
    snap.freightInr != null
      ? snap.freightInr
      : snap.deliveryCharges != null
        ? snap.deliveryCharges
        : snap.shippingCharges != null
          ? snap.shippingCharges
          : order?.deliveryCharges
  );
  return Number.isFinite(n) && n >= 0 ? round2(n) : null;
}

function mapCourierPublic(row) {
  const id = getCourierCompanyIdFromRow(row);
  const rate = Number(row?.rate ?? row?.freight_charge);
  const etd = Number(row?.estimated_delivery_days ?? row?.etd ?? row?.etd_hours);
  return {
    courierId: id,
    courierName: getCourierNameFromRow(row) || null,
    totalCharges: Number.isFinite(rate) ? round2(rate) : null,
    estimatedDays: Number.isFinite(etd) ? etd : null
  };
}

function enrichSuggested(picked, freightCap) {
  if (!picked) return null;
  const totalCharges =
    picked.rate != null && Number.isFinite(Number(picked.rate))
      ? round2(picked.rate)
      : Number.isFinite(Number(picked.courier?.rate ?? picked.courier?.freight_charge))
        ? round2(picked.courier.rate ?? picked.courier.freight_charge)
        : null;
  const gap =
    freightCap != null && totalCharges != null ? round2(Number(totalCharges) - Number(freightCap)) : null;
  return {
    courierId: picked.courierCompanyId,
    courierName: picked.courierName,
    totalCharges,
    estimatedDays: (() => {
      const etd = Number(
        picked.courier?.estimated_delivery_days ?? picked.courier?.etd ?? picked.courier?.etd_hours
      );
      return Number.isFinite(etd) ? etd : null;
    })(),
    exceedsQuotedFreight: gap != null ? gap > 0.05 : false,
    freightGapInr: gap != null && gap > 0.05 ? gap : gap != null && gap < -0.05 ? gap : 0
  };
}

async function loadLiveRatesSafe(order) {
  try {
    const parts = await ShiprocketService.buildAdhocPayloadParts(order);
    const deliveryPin = String(parts.addr?.postalCode || '')
      .replace(/\D/g, '')
      .slice(0, 6);
    if (deliveryPin.length !== 6) {
      return {
        ok: false,
        couriers: [],
        message: 'Order address must include a 6-digit delivery pincode.',
        code: 'INVALID_DELIVERY_PINCODE',
        parts
      };
    }
    const listRes = await ShiprocketService.listCouriersForRoute(deliveryPin, {
      weightKg: parts.totalWeight,
      lengthCm: parts.maxL,
      widthCm: parts.maxB,
      heightCm: parts.maxH,
      codAmount: parts.codAmountForQuote
    });
    const couriers = Array.isArray(listRes?.couriers) ? listRes.couriers : [];
    if (!listRes?.success || !couriers.length) {
      logger.warn('[Shiprocket] listCouriersForRoute returned no couriers', {
        orderId: order?.orderId,
        message: listRes?.message || null,
        deliveryPin
      });
      return {
        ok: false,
        couriers: [],
        message: listRes?.message || 'No courier available for this route',
        code: 'COURIER_LIST_FAILED',
        parts
      };
    }
    return { ok: true, couriers, message: null, code: null, parts };
  } catch (err) {
    logger.error('[Shiprocket] loadLiveRatesSafe threw', {
      orderId: order?.orderId,
      message: err.message,
      stack: err.stack
    });
    return {
      ok: false,
      couriers: [],
      message: err.message || 'Rate lookup failed',
      code: 'COURIER_LIST_FAILED',
      parts: null
    };
  }
}

function isWalletAssignFailure(assign) {
  if (!assign) return false;
  if (assign.code === 'SHIPROCKET_WALLET_OR_BALANCE') return true;
  return /recharge|wallet|balance|insufficient/i.test(String(assign.message || ''));
}

function unavailablePayload({
  message,
  quoted,
  suggested,
  available,
  freightCap,
  details,
  assignCode
}) {
  return {
    success: false,
    code: 'QUOTED_COURIER_UNAVAILABLE',
    message:
      message ||
      'Checkout courier could not be assigned on Shiprocket. Confirm a substitute courier, or assign from the Shiprocket panel. Customer order total is not changed.',
    quotedCourier: quoted?.courierId
      ? { courierId: quoted.courierId, courierName: quoted.courierName }
      : null,
    suggestedCourier: suggested,
    availableCouriers: (available || []).slice(0, 15).map(mapCourierPublic),
    quotedFreightInr: freightCap,
    customerBillUnchanged: true,
    details: details || null,
    assignCode: assignCode || null
  };
}

/**
 * Assign AWB with production substitute policy. Does not touch customer payment fields.
 *
 * @param {import('mongoose').Document} order
 * @param {object} opts
 * @param {string} opts.shipmentId
 * @param {number|null} [opts.courierIdOverride]
 * @param {boolean} [opts.confirmSubstitute]
 * @returns {Promise<object>}
 */
async function runShiprocketAssignAwb(order, opts = {}) {
  const { shipmentId, courierIdOverride = null, confirmSubstitute = false } = opts;

  try {
    if (!order) {
      return { success: false, code: 'ORDER_REQUIRED', message: 'Order is required.' };
    }
    const sid = String(shipmentId || '').trim();
    if (!sid) {
      return {
        success: false,
        code: 'SHIPMENT_ID_MISSING',
        message: 'Create/push shipment first (no shipment_id on order).'
      };
    }
    if (order.shipmentInfo?.awbCode || order.shipmentInfo?.trackingNumber) {
      return {
        success: false,
        code: 'AWB_ALREADY_ASSIGNED',
        message: 'AWB already assigned for this order.'
      };
    }

    const quoted = quotedCourierFromOrder(order);
    const freightCap = quotedFreightInr(order);
    const hasOverride =
      courierIdOverride != null && Number.isFinite(Number(courierIdOverride)) && Number(courierIdOverride) > 0;

    let available = [];
    let ratesLoaded = false;
    let parts = null;

    const ensureRates = async () => {
      if (ratesLoaded) return { ok: available.length > 0, couriers: available, parts };
      const rates = await loadLiveRatesSafe(order);
      available = rates.couriers;
      ratesLoaded = true;
      parts = rates.parts;
      return rates;
    };

    const codRequired = () => Boolean(parts?.useCodAtDoor);

    const suggestedFromRates = (excludeCourierIds = []) => {
      const picked = pickCheapestActiveCourier(available, {
        codRequired: codRequired(),
        maxCharge: freightCap,
        excludeCourierIds
      });
      return enrichSuggested(picked, freightCap);
    };

    const finishSuccess = ({ assign, courierId, courierName, substituted, substituteMeta }) => ({
      success: true,
      assign,
      courierId: Number(courierId),
      courierName: courierName || assign?.courier || null,
      substituted: Boolean(substituted),
      courierAssignNote: substituteMeta?.courierAssignNote || null,
      courierSubstitutedFromId: substituteMeta?.courierSubstitutedFromId ?? null,
      courierSubstitutedFromName: substituteMeta?.courierSubstitutedFromName ?? null,
      customerBillUnchanged: true,
      quotedFreightInr: freightCap
    });

    const assignTarget = async (targetId, meta = {}) => {
      const assign = await ShiprocketService.assignAwb({
        shipmentId: sid,
        courierId: Number(targetId)
      });
      if (!assign.success) {
        return { ok: false, assign };
      }
      const effectiveAwb =
        Boolean(assign.mock) ||
        Boolean(String(assign.awbCode || '').trim()) ||
        Boolean(String(assign.trackingNumber || '').trim()) ||
        Number(assign.raw?.awb_assign_status) === 1;
      if (!effectiveAwb) {
        const raw = assign.raw || {};
        const nested = raw.response?.data && typeof raw.response.data === 'object' ? raw.response.data : {};
        const walletMsg =
          nested.awb_assign_error ||
          raw.message ||
          assign.message ||
          'Shiprocket did not issue an AWB. Recharge the Shiprocket wallet or try another courier.';
        const walletish =
          assign.code === 'SHIPROCKET_WALLET_OR_BALANCE' ||
          /recharge|wallet|balance|insufficient/i.test(String(walletMsg || ''));
        return {
          ok: false,
          assign: {
            ...assign,
            success: false,
            code: walletish ? 'SHIPROCKET_WALLET_OR_BALANCE' : 'ASSIGN_AWB_NOT_COMPLETED',
            message: walletMsg,
            details: raw
          }
        };
      }
      return { ok: true, assign, ...meta };
    };

    // ── Override (admin picked / confirmed suggested id) ───────────────────
    if (hasOverride) {
      const targetId = Number(courierIdOverride);
      if (isCourierInactive({ id: targetId })) {
        return {
          success: false,
          code: 'COURIER_INACTIVE',
          message: 'Selected courier is inactive in our shipping policy. Pick another active courier.',
          customerBillUnchanged: true
        };
      }
      logger.info('[Shiprocket] Ship now: assign override courier', {
        orderId: order.orderId,
        shipmentId: sid,
        targetId,
        confirmSubstitute
      });
      const res = await assignTarget(targetId);
      if (!res.ok) {
        if (isWalletAssignFailure(res.assign)) {
          return {
            success: false,
            code: 'SHIPROCKET_WALLET_OR_BALANCE',
            message: res.assign.message,
            details: res.assign.details || res.assign.raw || null,
            customerBillUnchanged: true
          };
        }
        await ensureRates();
        return unavailablePayload({
          message:
            res.assign.message ||
            'Could not assign selected courier. Confirm another substitute or use the Shiprocket panel.',
          quoted,
          suggested: suggestedFromRates([quoted.courierId, courierIdOverride].filter(Boolean)),
          available,
          freightCap,
          details: res.assign.details || res.assign.raw || null,
          assignCode: res.assign.code
        });
      }
      const substituted =
        quoted.courierId != null && Number(targetId) !== Number(quoted.courierId);
      const substituteMeta = substituted
        ? {
            courierAssignNote: buildCourierSubstituteNote({
              quotedId: quoted.courierId,
              quotedName: quoted.courierName,
              assignedId: targetId,
              assignedName: res.assign.courier || String(targetId),
              reason: confirmSubstitute ? 'admin_confirm' : 'admin_confirm'
            }),
            courierSubstitutedFromId: quoted.courierId,
            courierSubstitutedFromName: quoted.courierName
          }
        : null;
      return finishSuccess({
        assign: res.assign,
        courierId: targetId,
        courierName: res.assign.courier || null,
        substituted,
        substituteMeta
      });
    }

    // ── Admin confirmed substitute without explicit id ─────────────────────
    if (confirmSubstitute) {
      const rates = await ensureRates();
      if (!rates.ok && quoted.courierId == null) {
        return {
          success: false,
          code: rates.code || 'NO_ACTIVE_COURIER',
          message:
            rates.message ||
            'No Shiprocket courier rates available. Retry later or assign from the Shiprocket panel.',
          customerBillUnchanged: true
        };
      }
      const suggested = suggestedFromRates(quoted.courierId != null ? [quoted.courierId] : []);
      let targetId = suggested?.courierId ?? null;
      let courierName = suggested?.courierName || null;
      let reason = 'admin_confirm';

      if (targetId == null && quoted.courierId != null) {
        logger.info('[Shiprocket] confirmSubstitute with empty/poor rates — retry quoted', {
          orderId: order.orderId,
          quotedCourierId: quoted.courierId
        });
        targetId = Number(quoted.courierId);
        courierName = quoted.courierName;
        reason = 'assign_failed';
      }
      if (targetId == null) {
        return {
          success: false,
          code: 'NO_ACTIVE_COURIER',
          message:
            'No active courier available for this route. Assign from the Shiprocket panel or retry shortly.',
          customerBillUnchanged: true
        };
      }
      if (isCourierInactive({ id: targetId, name: courierName })) {
        return {
          success: false,
          code: 'COURIER_INACTIVE',
          message: 'Suggested courier is inactive in our shipping policy. Pick another from the Shiprocket panel.',
          customerBillUnchanged: true
        };
      }

      const res = await assignTarget(targetId);
      if (!res.ok) {
        if (isWalletAssignFailure(res.assign)) {
          return {
            success: false,
            code: 'SHIPROCKET_WALLET_OR_BALANCE',
            message: res.assign.message,
            details: res.assign.details || res.assign.raw || null,
            customerBillUnchanged: true
          };
        }
        return {
          success: false,
          code: res.assign.code || 'ASSIGN_AWB_FAILED',
          message: res.assign.message || 'Shiprocket assign AWB failed',
          details: res.assign.details || res.assign.raw || null,
          suggestedCourier: suggested,
          availableCouriers: available.slice(0, 15).map(mapCourierPublic),
          customerBillUnchanged: true
        };
      }
      const substituted =
        quoted.courierId == null || Number(targetId) !== Number(quoted.courierId);
      return finishSuccess({
        assign: res.assign,
        courierId: targetId,
        courierName: res.assign.courier || courierName,
        substituted,
        substituteMeta: substituted
          ? {
              courierAssignNote: buildCourierSubstituteNote({
                quotedId: quoted.courierId,
                quotedName: quoted.courierName,
                assignedId: targetId,
                assignedName: res.assign.courier || courierName || String(targetId),
                reason
              }),
              courierSubstitutedFromId: quoted.courierId,
              courierSubstitutedFromName: quoted.courierName
            }
          : null
      });
    }

    // ── Prefer quoted courier FIRST (no rate pre-veto) ─────────────────────
    if (quoted.courierId != null) {
      if (isCourierInactive({ id: quoted.courierId, name: quoted.courierName })) {
        await ensureRates();
        const suggested = suggestedFromRates(quoted.courierId != null ? [quoted.courierId] : []);
        return unavailablePayload({
          message: `Checkout courier "${quoted.courierName || quoted.courierId}" is inactive in our shipping policy. Confirm a substitute (customer bill unchanged), or assign from the Shiprocket panel.`,
          quoted,
          suggested,
          available,
          freightCap,
          details: null,
          assignCode: 'COURIER_INACTIVE'
        });
      }

      logger.info('[Shiprocket] Ship now: assign quoted courier first', {
        orderId: order.orderId,
        shipmentId: sid,
        quotedCourierId: quoted.courierId,
        quotedCourierName: quoted.courierName
      });

      const direct = await assignTarget(Number(quoted.courierId));
      if (direct.ok) {
        return finishSuccess({
          assign: direct.assign,
          courierId: Number(quoted.courierId),
          courierName: direct.assign.courier || quoted.courierName,
          substituted: false,
          substituteMeta: null
        });
      }

      if (isWalletAssignFailure(direct.assign)) {
        return {
          success: false,
          code: 'SHIPROCKET_WALLET_OR_BALANCE',
          message: direct.assign.message,
          details: direct.assign.details || direct.assign.raw || null,
          customerBillUnchanged: true
        };
      }

      await ensureRates();
      const suggested = suggestedFromRates(quoted.courierId != null ? [quoted.courierId] : []);
      logger.warn('[Shiprocket] Quoted assign failed; offering substitute', {
        orderId: order.orderId,
        quotedCourierId: quoted.courierId,
        assignMessage: direct.assign.message,
        rateCount: available.length,
        suggestedCourierId: suggested?.courierId || null,
        freightCap
      });

      const gapNote =
        suggested?.exceedsQuotedFreight && suggested.freightGapInr != null
          ? ` Suggested courier is ₹${suggested.freightGapInr} above customer-paid shipping — gap is merchant-side only (customer bill unchanged).`
          : ' Customer order total is not changed.';

      return unavailablePayload({
        message: `${direct.assign.message || `Could not assign checkout courier "${quoted.courierName || quoted.courierId}".`}${gapNote}`,
        quoted,
        suggested,
        available,
        freightCap,
        details: direct.assign.details || direct.assign.raw || null,
        assignCode: direct.assign.code
      });
    }

    // ── No quoted courier — require confirm before booking cheapest ─────────
    const rates = await ensureRates();
    if (!rates.ok) {
      return {
        success: false,
        code: rates.code || 'COURIER_LIST_FAILED',
        message: rates.message || 'Could not load active couriers for this route.',
        customerBillUnchanged: true
      };
    }
    const suggested = suggestedFromRates();
    if (!suggested) {
      return {
        success: false,
        code: 'NO_ACTIVE_COURIER',
        message:
          'No active courier available for this route. Inactive couriers are excluded — enable a courier on Shiprocket or adjust shipping policy.',
        customerBillUnchanged: true
      };
    }
    return unavailablePayload({
      message:
        'No checkout courier was stored on this order. Confirm to assign the cheapest available Shiprocket courier (customer bill unchanged), or pass courierId.',
      quoted: null,
      suggested,
      available,
      freightCap,
      details: null,
      assignCode: null
    });
  } catch (err) {
    logger.error('[Shiprocket] runShiprocketAssignAwb unexpected error', {
      orderId: order?.orderId,
      message: err.message,
      stack: err.stack
    });
    return {
      success: false,
      code: 'ASSIGN_INTERNAL_ERROR',
      message: err.message || 'Unexpected error while assigning Shiprocket courier.',
      customerBillUnchanged: true
    };
  }
}

module.exports = {
  runShiprocketAssignAwb,
  quotedCourierFromOrder,
  quotedFreightInr
};
