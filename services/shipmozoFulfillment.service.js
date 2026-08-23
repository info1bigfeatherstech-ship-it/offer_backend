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

function round2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return Math.round(x * 100) / 100;
}

function normalizeCourierId(id) {
  const n = Number(id);
  return Number.isFinite(n) ? n : null;
}

function courierIdsEqual(a, b) {
  const na = normalizeCourierId(a);
  const nb = normalizeCourierId(b);
  return na != null && nb != null && na === nb;
}

function isExcludedCourier(courierId, excludeCourierIds) {
  const id = normalizeCourierId(courierId);
  if (id == null) return false;
  const set = new Set(
    (Array.isArray(excludeCourierIds) ? excludeCourierIds : [])
      .map(normalizeCourierId)
      .filter((x) => x != null)
  );
  return set.has(id);
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
 * Ranked substitute candidates — never includes excluded ids (e.g. failed checkout courier).
 * @param {Array<object>} available
 * @param {{ codRequired?: boolean, maxCharge?: number|null, excludeCourierIds?: number[], allowAboveMaxCharge?: boolean }} [opts]
 */
function listSubstituteCandidates(available, opts = {}) {
  const { codRequired = false, maxCharge = null, excludeCourierIds = [], allowAboveMaxCharge = false } =
    opts;
  let pool = (Array.isArray(available) ? available : []).filter(
    (c) =>
      c.courierId != null &&
      Number.isFinite(c.totalCharges) &&
      !isExcludedCourier(c.courierId, excludeCourierIds)
  );
  if (codRequired) {
    const codPool = pool.filter((c) => c.codAvailable !== false);
    if (codPool.length) pool = codPool;
  }
  if (!pool.length) return [];

  pool.sort((a, b) => {
    if (a.totalCharges !== b.totalCharges) return a.totalCharges - b.totalCharges;
    return String(a.courierName || '').localeCompare(String(b.courierName || ''));
  });

  if (maxCharge != null && Number.isFinite(Number(maxCharge))) {
    const cap = Number(maxCharge) + 0.05;
    const under = pool.filter((c) => Number(c.totalCharges) <= cap);
    if (under.length) return under;
    if (!allowAboveMaxCharge) return [];
  }

  return pool;
}

/**
 * Prefer cheapest courier with totalCharges <= maxCharge; else overall cheapest (when allowed).
 * Always excludes failed/quoted courier ids when provided.
 */
function pickSubstituteCourier(available, opts = {}) {
  const list = listSubstituteCandidates(available, opts);
  return list[0] || null;
}

function enrichSuggestedSm(picked, freightCap) {
  if (!picked) return null;
  const totalCharges =
    picked.totalCharges != null && Number.isFinite(Number(picked.totalCharges))
      ? round2(picked.totalCharges)
      : null;
  const gap =
    freightCap != null && totalCharges != null ? round2(Number(totalCharges) - Number(freightCap)) : null;
  return {
    courierId: picked.courierId,
    courierName: picked.courierName,
    totalCharges,
    estimatedDays: picked.estimatedDays ?? null,
    exceedsQuotedFreight: gap != null ? gap > 0.05 : false,
    freightGapInr: gap != null && gap > 0.05 ? gap : gap != null && gap < -0.05 ? gap : 0
  };
}

function buildUnavailablePayload({
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
    code: suggested ? 'QUOTED_COURIER_UNAVAILABLE' : 'NO_ALTERNATE_COURIER',
    message:
      message ||
      (suggested
        ? 'Checkout courier could not be assigned on Shipmozo. Confirm a substitute courier, or assign from the Shipmozo panel.'
        : 'Checkout courier could not be assigned and no alternate Shipmozo courier is available for this route. Assign from the Shipmozo panel.'),
    quotedCourier: quoted?.courierId
      ? { courierId: quoted.courierId, courierName: quoted.courierName }
      : null,
    suggestedCourier: suggested,
    availableCouriers: (available || []).slice(0, 15).map(mapCourierPublic),
    quotedFreightInr: freightCap ?? null,
    customerBillUnchanged: true,
    details: details || null,
    assignCode: assignCode || null
  };
}

/**
 * Pincode / route service errors — try another courier, do NOT treat as panel-booked.
 * @param {string|null|undefined} message
 */
function isShipmozoServiceabilityAssignError(message) {
  const m = String(message || '').toLowerCase();
  if (!m) return false;
  return (
    /not provide service|does not provide|do not provide|non[\s-]*serviceable|\bnsz\b|not serviceable|serviceability|pincode|pin code|cannot deliver|can't deliver|does not deliver|delivery not available|route not available|unserviceable/.test(
      m
    ) && !/already\s*(assigned|booked|scheduled)/.test(m)
  );
}

/**
 * @param {string|null|undefined} message
 */
function isShipmozoAlreadyBookedAssignError(message) {
  const m = String(message || '').toLowerCase();
  if (!m) return false;
  if (isShipmozoServiceabilityAssignError(message)) return false;
  return (
    /already\s*(assigned|booked|scheduled)|courier\s*already|pickup\s*already|order\s*already/.test(m) ||
    /invalid\s*order\s*id|wrong\s*order\s*id|order\s*id\s*(is\s*)?(wrong|invalid|not\s*found)/.test(m)
  );
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
 * Build ordered assign attempts: preferred id first (if valid), then ranked substitutes.
 */
function buildAssignAttemptList(available, opts = {}) {
  const {
    codRequired = false,
    freightCap = null,
    excludeCourierIds = [],
    preferredCourierId = null,
    allowAboveMaxCharge = false
  } = opts;

  const underCap = listSubstituteCandidates(available, {
    codRequired,
    maxCharge: freightCap,
    excludeCourierIds,
    allowAboveMaxCharge: false
  });
  let aboveCap = [];
  if (allowAboveMaxCharge && underCap.length === 0) {
    aboveCap = listSubstituteCandidates(available, {
      codRequired,
      maxCharge: freightCap,
      excludeCourierIds,
      allowAboveMaxCharge: true
    });
  }
  const ranked = [...underCap, ...aboveCap.filter((c) => !underCap.some((u) => courierIdsEqual(u.courierId, c.courierId)))];

  const pref = normalizeCourierId(preferredCourierId);
  if (pref == null || isExcludedCourier(pref, excludeCourierIds)) {
    return ranked;
  }
  const prefRow = ranked.find((c) => courierIdsEqual(c.courierId, pref));
  if (!prefRow) {
    return ranked;
  }
  return [prefRow, ...ranked.filter((c) => !courierIdsEqual(c.courierId, pref))];
}

/**
 * Try assign-courier for each candidate until one succeeds.
 */
async function tryAssignSubstituteCouriers({
  smOrderId,
  order,
  candidates,
  quoted,
  available,
  applyUpsertShipmentInfo,
  evaluateAndPersistShipmentOps
}) {
  const failedAttempts = [];

  for (const candidate of candidates) {
    const targetCourierId = Number(candidate.courierId);
    if (!Number.isFinite(targetCourierId)) continue;

    const assign = await ShipmozoService.assignCourier({
      orderId: smOrderId,
      courierId: targetCourierId
    });

    if (assign.success) {
      const substituted = quoted.courierId != null && !courierIdsEqual(targetCourierId, quoted.courierId);
      const substituteMeta = substituted
        ? {
            courierAssignNote: quoted.courierId
              ? `Quoted courier ${quoted.courierName || quoted.courierId} could not be assigned; assigned ${candidate.courierName || targetCourierId} after admin confirm.`
              : `Assigned ${candidate.courierName || targetCourierId} after admin confirm.`,
            courierSubstitutedFromId: quoted.courierId,
            courierSubstitutedFromName: quoted.courierName
          }
        : null;

      return finalizeShipmozoAssign({
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
      });
    }

    failedAttempts.push({
      courierId: targetCourierId,
      courierName: candidate.courierName || null,
      message: assign.message || 'Assign failed',
      code: assign.code || null
    });

    if (isShipmozoAlreadyBookedAssignError(assign.message)) {
      return {
        success: false,
        panelBooked: true,
        message: assign.message,
        failedAttempts,
        assign
      };
    }
  }

  return {
    success: false,
    panelBooked: false,
    failedAttempts
  };
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

    const failedCourierIds = [];

    const ensureRates = async () => {
      if (ratesLoaded) return available;
      const rates = await loadLiveRatesSafe(order);
      available = rates.couriers;
      ratesLoaded = true;
      return available;
    };

    const buildExcludeIds = () => {
      const ids = [];
      if (quoted.courierId != null) ids.push(quoted.courierId);
      for (const id of failedCourierIds) ids.push(id);
      return ids;
    };

    const suggestedFromRates = (opts = {}) => {
      const picked = pickSubstituteCourier(available, {
        codRequired,
        maxCharge: freightCap,
        excludeCourierIds: buildExcludeIds(),
        allowAboveMaxCharge: Boolean(opts.allowAboveMaxCharge)
      });
      return enrichSuggestedSm(picked, freightCap);
    };

    const listPublicAlternates = () =>
      listSubstituteCandidates(available, {
        codRequired,
        maxCharge: freightCap,
        excludeCourierIds: buildExcludeIds(),
        allowAboveMaxCharge: true
      })
        .slice(0, 15)
        .map(mapCourierPublic);

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

      failedCourierIds.push(Number(quoted.courierId));

      // Assign failed — load rates only to suggest alternatives (never claim "unavailable"
      // solely because our rate list was empty before trying assign).
      await ensureRates();
      let suggested = suggestedFromRates();
      if (!suggested) {
        suggested = suggestedFromRates({ allowAboveMaxCharge: true });
      }

      logger.warn('[Shipmozo] Quoted assign failed; offering substitute', {
        orderId: order.orderId,
        quotedCourierId: quoted.courierId,
        assignMessage: direct.message,
        rateCount: available.length,
        suggestedCourierId: suggested?.courierId || null,
        serviceabilityError: isShipmozoServiceabilityAssignError(direct.message)
      });

      const gapNote =
        suggested?.exceedsQuotedFreight && suggested?.freightGapInr != null
          ? ` Suggested courier is ₹${suggested.freightGapInr} above customer-paid shipping — gap is merchant-side only (customer bill unchanged).`
          : ' Customer order total is not changed.';

      return buildUnavailablePayload({
        message: `${direct.message || `Could not assign checkout courier "${quoted.courierName || quoted.courierId}".`}${gapNote}`,
        quoted,
        suggested,
        available,
        freightCap,
        details: direct.raw || null,
        assignCode: direct.code
      });
    }

    // ── Path: admin confirmed substitute / no quoted / override ─────────────
    if (!hasOverride) {
      await ensureRates();
      let suggested = suggestedFromRates();
      if (!suggested) {
        suggested = suggestedFromRates({ allowAboveMaxCharge: true });
      }

      if (quoted.courierId == null && !confirmSubstitute) {
        if (!suggested) {
          return {
            success: false,
            code: 'NO_QUOTED_COURIER',
            message:
              'No checkout courier on this order and no Shipmozo rates returned. Retry shortly or assign from the Shipmozo panel.',
            quotedCourier: null,
            suggestedCourier: null,
            availableCouriers: [],
            customerBillUnchanged: true
          };
        }
        return buildUnavailablePayload({
          message:
            'No checkout courier was stored on this order. Confirm to assign the cheapest available Shipmozo courier, or pass courierId.',
          quoted: null,
          suggested,
          available,
          freightCap
        });
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
          return buildUnavailablePayload({
            message:
              'No alternate Shipmozo courier is available for this route after excluding the checkout courier. Assign from the Shipmozo panel.',
            quoted,
            suggested: null,
            available,
            freightCap
          });
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
            availableCouriers: listPublicAlternates(),
            customerBillUnchanged: true
          };
        }
      }
    }

    // When admin confirmed substitute (or picked override), try ranked couriers — never re-assign
    // the failed checkout courier unless it is the only explicit override and rates are empty.
    if (confirmSubstitute || hasOverride) {
      if (!ratesLoaded) await ensureRates();

      const preferredId =
        hasOverride && !courierIdsEqual(courierIdOverride, quoted.courierId)
          ? Number(courierIdOverride)
          : targetCourierId;

      const excludeIds = buildExcludeIds();
      if (quoted.courierId != null && !excludeIds.some((id) => courierIdsEqual(id, quoted.courierId))) {
        excludeIds.push(quoted.courierId);
      }

      let candidates = buildAssignAttemptList(available, {
        codRequired,
        freightCap,
        excludeCourierIds: excludeIds,
        preferredCourierId: preferredId,
        allowAboveMaxCharge: true
      });

      if (!candidates.length && hasOverride && !courierIdsEqual(courierIdOverride, quoted.courierId)) {
        const overrideRow = available.find((c) => courierIdsEqual(c.courierId, courierIdOverride));
        if (overrideRow) candidates = [overrideRow];
      }

      if (!candidates.length) {
        return buildUnavailablePayload({
          message:
            'No alternate Shipmozo courier could be assigned for this route. Assign from the Shipmozo panel.',
          quoted,
          suggested: suggestedFromRates({ allowAboveMaxCharge: true }),
          available,
          freightCap
        });
      }

      logger.info('[Shipmozo] Ship now: trying substitute courier(s)', {
        orderId: order.orderId,
        smOrderId,
        attemptIds: candidates.map((c) => c.courierId),
        confirmSubstitute,
        hasOverride
      });

      const attempt = await tryAssignSubstituteCouriers({
        smOrderId,
        order,
        candidates,
        quoted,
        available,
        applyUpsertShipmentInfo,
        evaluateAndPersistShipmentOps
      });

      if (attempt.success) {
        return {
          ...attempt,
          customerBillUnchanged: true,
          quotedFreightInr: freightCap
        };
      }

      if (attempt.panelBooked) {
        return syncFromPanelInsteadOfAssign(order, { evaluateAndPersistShipmentOps });
      }

      for (const f of attempt.failedAttempts || []) {
        if (f.courierId != null) failedCourierIds.push(f.courierId);
      }

      const nextSuggested = suggestedFromRates({ allowAboveMaxCharge: true });
      const lastMsg =
        attempt.failedAttempts?.[attempt.failedAttempts.length - 1]?.message ||
        'Shipmozo assign-courier failed for all substitute couriers.';

      return buildUnavailablePayload({
        message: `${lastMsg} Assign from the Shipmozo panel if needed.`,
        quoted,
        suggested: nextSuggested,
        available,
        freightCap,
        details: attempt.failedAttempts || null
      });
    }

    return {
      success: false,
      code: 'ASSIGN_PATH_UNREACHABLE',
      message: 'Could not determine Shipmozo assign path for this order. Retry Ship now or assign from the Shipmozo panel.',
      customerBillUnchanged: true
    };
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
  pickSubstituteCourier,
  listSubstituteCandidates,
  enrichSuggestedSm,
  isShipmozoServiceabilityAssignError,
  isShipmozoAlreadyBookedAssignError,
  courierIdsEqual
};
