/**
 * RTO refund calculation & eligibility — platform fee from env tiers on order total
 * (subtotal + deliveryCharges). Full online payment only; COD/partial → no refund.
 */
const { roundMoney2 } = require('./checkoutComputation.service');
const { loadPlatformFeeTiers } = require('../config/rtoPlatformFee.config');

function getMinOrderValueForRefund() {
  const n = Number(process.env.RTO_MIN_ORDER_VALUE_FOR_REFUND);
  return Number.isFinite(n) && n >= 0 ? roundMoney2(n) : 100;
}

function getMinRefundThreshold() {
  const n = Number(process.env.RTO_MIN_REFUND_THRESHOLD);
  return Number.isFinite(n) && n >= 0 ? roundMoney2(n) : 20;
}

const CUSTOMER_RTO_REASON_RE =
  /refus|unavail|not available|customer not|rejected by customer|buyer cancel|consignee refused|did not accept|not reachable|customer unavailable|refused to accept/i;
const COURIER_RTO_REASON_RE =
  /wrong address|address issue|pincode|pin code|delivery failed|undelivered|could not deliver|oda|out of delivery|non serviceable|nsz|misroute|damaged in transit|maximum attempt|address incomplete|invalid address/i;

/** Mongo $regex strings (Shiprocket providerStatus) */
const CUSTOMER_RTO_PROVIDER_REGEX =
  'refus|unavail|not available|customer not|rejected by customer|buyer cancel|consignee refused|did not accept|not reachable|refused to accept';
const COURIER_RTO_PROVIDER_REGEX =
  'wrong address|address issue|pincode|pin code|delivery failed|undelivered|could not deliver|oda|out of delivery|non serviceable|nsz|misroute|damaged in transit|maximum attempt|address incomplete|invalid address';

/**
 * @param {number} orderTotalInr — subtotal + deliveryCharges
 * @returns {{ percent: number, fee: number, tier: object|null }}
 */
function calculatePlatformFee(orderTotalInr) {
  const orderTotal = roundMoney2(Number(orderTotalInr) || 0);
  const tiers = loadPlatformFeeTiers();
  const tier =
    tiers.find((t) => {
      const aboveMin = orderTotal >= t.min;
      const belowMax = t.max == null || orderTotal <= t.max;
      return aboveMin && belowMax;
    }) || tiers[tiers.length - 1];

  const rawFee = roundMoney2((orderTotal * tier.percent) / 100);
  const fee = roundMoney2(Math.min(rawFee, tier.cap));
  return { percent: tier.percent, fee, tier };
}

/**
 * RTO order total for fee + refund base: cart value + forward shipping (excludes tax/discount).
 * @param {import('mongoose').Document|object} order
 * @returns {number}
 */
function getRtoOrderTotal(order) {
  const cartValue = roundMoney2(Number(order?.subtotal) || 0);
  const forwardShipping = getForwardShippingFromOrder(order);
  return roundMoney2(cartValue + forwardShipping);
}

/**
 * Amount used for the ₹100 minimum RTO refund gate.
 * Full order value = items (cart) + forward shipping. Never items-only.
 * Also considers totalAmount / amountPaid when those are higher (partial+COD total).
 * @param {import('mongoose').Document|object} order
 * @returns {number}
 */
function getOrderAmountForRtoMinGate(order) {
  const withShipping = getRtoOrderTotal(order);
  const totalAmount = roundMoney2(Number(order?.totalAmount) || 0);
  const paid = roundMoney2(Number(order?.amountPaidInr) || 0);
  return roundMoney2(Math.max(withShipping, totalAmount, paid));
}

/**
 * @param {import('mongoose').Document|object} order
 * @returns {number}
 */
function getForwardShippingFromOrder(order) {
  return roundMoney2(Number(order?.deliveryCharges) || 0);
}

/**
 * RTO return freight from persisted Shiprocket fields when present.
 * Does not call Shiprocket — use {@link syncRtoFreightChargeFromShiprocket} to populate.
 * @param {import('mongoose').Document|object} order
 * @returns {number}
 */
function getRtoShippingFromOrder(order) {
  try {
    const si = order?.shipmentInfo || {};
    const ri = order?.returnInfo || {};
    const refundLocked =
      ri.rtoRefundAmount != null ||
      Boolean(ri.rtoRefundId) ||
      String(ri.rtoStatus || '').toLowerCase() === 'refunded';

    const storedDeduction = ri.rtoDeductions?.rtoShipping;
    if (storedDeduction != null && Number.isFinite(Number(storedDeduction))) {
      const n = roundMoney2(Number(storedDeduction));
      // Trust saved deductions after refund; otherwise ignore placeholder 0 so live fields can win.
      if (refundLocked || n > 0.005) return n;
    }

    const candidates = [
      ri.rtoShippingCharges,
      si.rtoFreightCharge,
      si.rtoShippingCharge,
      si.rto_charge,
      si.freight_charge_rto
    ];
    for (const c of candidates) {
      const n = Number(c);
      if (Number.isFinite(n) && n > 0.005) return roundMoney2(n);
    }

    const events = Array.isArray(si.rawEvents) ? si.rawEvents : [];
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const ev = events[i] || {};
      const freight = ev.rto_freight ?? ev.rto_charge ?? ev.rto_amount;
      const n = Number(freight);
      if (Number.isFinite(n) && n > 0.005) return roundMoney2(n);
    }

    const envDefault = Number(process.env.RTO_DEFAULT_SHIPPING_CHARGE);
    if (Number.isFinite(envDefault) && envDefault >= 0) {
      return roundMoney2(envDefault);
    }
    return 0;
  } catch {
    return 0;
  }
}

const RTO_FREIGHT_RESYNC_MS = 24 * 60 * 60 * 1000;

/**
 * True when we should attempt a read-only Shiprocket freight lookup.
 * @param {import('mongoose').Document|object} order
 */
function orderNeedsRtoFreightSync(order) {
  try {
    if (!order) return false;
    if (getRtoShippingFromOrder(order) > 0.005) return false;

    const si = order.shipmentInfo || {};
    const ri = order.returnInfo || {};
    const hasRef = Boolean(
      (si.shipmentId && String(si.shipmentId).trim()) ||
        (si.shiprocketOrderId && String(si.shiprocketOrderId).trim()) ||
        (order.orderId && String(order.orderId).trim())
    );
    if (!hasRef) return false;

    const syncedAt = ri.rtoFreightSyncedAt || si.rtoFreightSyncedAt;
    if (syncedAt) {
      const age = Date.now() - new Date(syncedAt).getTime();
      if (Number.isFinite(age) && age >= 0 && age < RTO_FREIGHT_RESYNC_MS) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Apply a positive RTO freight amount onto the order document (in-memory).
 * @param {import('mongoose').Document|object} order
 * @param {number} amountInr
 * @returns {boolean}
 */
function applyRtoFreightChargeToOrder(order, amountInr) {
  try {
    const n = roundMoney2(Number(amountInr));
    if (!Number.isFinite(n) || n < 0.01) return false;
    if (!order.returnInfo) order.returnInfo = {};
    if (!order.shipmentInfo) order.shipmentInfo = {};
    order.returnInfo.rtoShippingCharges = n;
    order.returnInfo.rtoFreightSyncedAt = new Date();
    order.shipmentInfo.rtoFreightCharge = n;
    order.shipmentInfo.rtoFreightSyncedAt = new Date();
    if (typeof order.markModified === 'function') {
      order.markModified('returnInfo');
      order.markModified('shipmentInfo');
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Mark that we attempted a freight sync (even if amount not found) to avoid API hammering.
 * @param {import('mongoose').Document|object} order
 */
function markRtoFreightSyncAttempted(order) {
  try {
    if (!order) return;
    if (!order.returnInfo) order.returnInfo = {};
    if (!order.shipmentInfo) order.shipmentInfo = {};
    const now = new Date();
    order.returnInfo.rtoFreightSyncedAt = now;
    order.shipmentInfo.rtoFreightSyncedAt = now;
    if (typeof order.markModified === 'function') {
      order.markModified('returnInfo');
      order.markModified('shipmentInfo');
    }
  } catch {
    /* ignore */
  }
}

/**
 * Read-only Shiprocket lookup → persist RTO reverse freight on the order when found.
 * Never creates/assigns/cancels shipments. Safe to call from RTO admin paths only.
 * @param {import('mongoose').Document|object} order
 * @param {{ force?: boolean, persist?: boolean }} [options]
 * @returns {Promise<{ updated: boolean, amountInr: number, code?: string|null }>}
 */
async function syncRtoFreightChargeFromShiprocket(order, options = {}) {
  try {
    if (!order) return { updated: false, amountInr: 0, code: 'NO_ORDER' };
    if (!options.force && !orderNeedsRtoFreightSync(order)) {
      return { updated: false, amountInr: getRtoShippingFromOrder(order), code: 'SKIPPED' };
    }

    const ShiprocketService = require('../utils/shiprocket');
    const si = order.shipmentInfo || {};
    const result = await ShiprocketService.fetchRtoFreightCharge({
      shipmentId: si.shipmentId,
      shiprocketOrderId: si.shiprocketOrderId,
      channelOrderId: order.orderId
    });

    if (result?.success && result.rtoFreightInr != null && Number(result.rtoFreightInr) > 0.005) {
      const applied = applyRtoFreightChargeToOrder(order, result.rtoFreightInr);
      if (applied && options.persist !== false && typeof order.save === 'function') {
        try {
          await order.save();
        } catch (_) {
          /* caller may persist lean updates separately */
        }
      }
      return {
        updated: applied,
        amountInr: roundMoney2(Number(result.rtoFreightInr)),
        code: result.source || 'OK'
      };
    }

    markRtoFreightSyncAttempted(order);
    if (options.persist !== false && typeof order.save === 'function') {
      try {
        await order.save();
      } catch (_) {
        /* non-blocking */
      }
    }
    return {
      updated: false,
      amountInr: 0,
      code: result?.code || 'RTO_FREIGHT_NOT_FOUND'
    };
  } catch (err) {
    try {
      markRtoFreightSyncAttempted(order);
    } catch (_) {
      /* ignore */
    }
    return { updated: false, amountInr: 0, code: 'RTO_FREIGHT_SYNC_ERROR' };
  }
}

/**
 * Enrich a page of RTO orders with missing reverse freight (bounded concurrency).
 * Mutates lean docs in place and persists via updateOne — does not throw.
 * @param {Array<object>} orders
 * @param {{ concurrency?: number, maxOrders?: number }} [options]
 * @returns {Promise<number>} number of orders updated with a positive charge
 */
async function enrichRtoOrdersFreightCharges(orders, options = {}) {
  const list = Array.isArray(orders) ? orders : [];
  const concurrency = Math.min(4, Math.max(1, Number(options.concurrency) || 3));
  const maxOrders = Math.min(list.length, Math.max(1, Number(options.maxOrders) || 8));
  const targets = list.filter((o) => orderNeedsRtoFreightSync(o)).slice(0, maxOrders);
  if (!targets.length) return 0;

  const Order = require('../models/Order');
  let updatedCount = 0;
  let idx = 0;

  async function worker() {
    while (idx < targets.length) {
      const current = targets[idx];
      idx += 1;
      try {
        const result = await syncRtoFreightChargeFromShiprocket(current, { persist: false });
        if (result.updated && result.amountInr > 0.005 && current?._id) {
          await Order.updateOne(
            { _id: current._id },
            {
              $set: {
                'returnInfo.rtoShippingCharges': result.amountInr,
                'returnInfo.rtoFreightSyncedAt': new Date(),
                'shipmentInfo.rtoFreightCharge': result.amountInr,
                'shipmentInfo.rtoFreightSyncedAt': new Date()
              }
            }
          );
          if (!current.returnInfo) current.returnInfo = {};
          if (!current.shipmentInfo) current.shipmentInfo = {};
          current.returnInfo.rtoShippingCharges = result.amountInr;
          current.returnInfo.rtoFreightSyncedAt = new Date();
          current.shipmentInfo.rtoFreightCharge = result.amountInr;
          current.shipmentInfo.rtoFreightSyncedAt = new Date();
          updatedCount += 1;
        } else if (current?._id) {
          await Order.updateOne(
            { _id: current._id },
            {
              $set: {
                'returnInfo.rtoFreightSyncedAt': new Date(),
                'shipmentInfo.rtoFreightSyncedAt': new Date()
              }
            }
          );
          if (!current.returnInfo) current.returnInfo = {};
          current.returnInfo.rtoFreightSyncedAt = new Date();
        }
      } catch (_) {
        /* skip this order */
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, () => worker()));
  return updatedCount;
}

/**
 * @param {import('mongoose').Document|object} order
 * @returns {{ eligible: boolean, reason: string, paymentMethod: string|null, paymentStatus: string|null }}
 */
function classifyRtoRefundEligibility(order) {
  const method = String(order?.paymentInfo?.method || '').toLowerCase();
  const status = String(order?.paymentStatus || '').toLowerCase();

  if (method === 'cod') {
    return {
      eligible: false,
      reason: 'cod_no_refund',
      paymentMethod: method,
      paymentStatus: status
    };
  }

  if (method !== 'online' && method !== 'prepaid') {
    return {
      eligible: false,
      reason: 'unsupported_payment_method',
      paymentMethod: method || null,
      paymentStatus: status
    };
  }

  if (status !== 'paid') {
    return {
      eligible: false,
      reason: 'partial_or_unpaid_no_refund',
      paymentMethod: method,
      paymentStatus: status
    };
  }

  const total = roundMoney2(order.totalAmount);
  const paid = roundMoney2(Number(order.amountPaidInr) || total);
  if (paid + 0.005 < total) {
    return {
      eligible: false,
      reason: 'partial_payment_no_refund',
      paymentMethod: method,
      paymentStatus: status
    };
  }

  return {
    eligible: true,
    reason: 'full_online_payment',
    paymentMethod: method,
    paymentStatus: status
  };
}

/**
 * @param {import('mongoose').Document|object} order
 * @param {{ rtoShippingOverride?: number|null }} [options]
 */
function calculateRtoRefund(order, options = {}) {
  const eligibility = classifyRtoRefundEligibility(order);
  const cartValue = roundMoney2(Number(order?.subtotal) || 0);
  const forwardShipping = getForwardShippingFromOrder(order);
  const orderTotal = getRtoOrderTotal(order);
  const minGateAmount = getOrderAmountForRtoMinGate(order);
  const rtoShipping =
    options.rtoShippingOverride != null && Number.isFinite(Number(options.rtoShippingOverride))
      ? roundMoney2(Number(options.rtoShippingOverride))
      : getRtoShippingFromOrder(order);
  const { percent: platformFeePercent, fee: platformFee } = calculatePlatformFee(orderTotal);

  const deductions = {
    forwardShipping,
    rtoShipping,
    platformFee,
    platformFeePercent,
    orderTotal,
    cartValue
  };

  const totalDeductions = roundMoney2(forwardShipping + rtoShipping + platformFee);
  const minOrderValue = getMinOrderValueForRefund();
  const minRefundThreshold = getMinRefundThreshold();

  const buildBlocked = (reason, extra = {}) => ({
    eligible: false,
    reason,
    cartValue,
    orderTotal,
    minGateAmount,
    deductions,
    totalDeductions,
    netRefund: 0,
    maxRefundableInr: 0,
    minOrderValue,
    minRefundThreshold,
    ...extra
  });

  if (!eligibility.eligible) {
    return buildBlocked(eligibility.reason);
  }

  // ₹100 gate: items + shipping (full order value), not cart/items alone.
  if (minGateAmount + 0.005 < minOrderValue) {
    return buildBlocked('order_below_min_value', {
      orderTotalBelowMin: true
    });
  }

  const rawNet = roundMoney2(orderTotal - totalDeductions);
  const netRefund = rawNet > 0 ? rawNet : 0;

  if (netRefund <= minRefundThreshold + 0.005) {
    return buildBlocked('refund_below_min_threshold', {
      netRefund,
      refundBelowMin: true
    });
  }

  const alreadyRefundedInr = roundMoney2(
    (order?.refundHistory || []).reduce((s, r) => s + (Number(r.amountInr) || 0), 0)
  );
  const paidInr = roundMoney2(Number(order?.amountPaidInr) || Number(order?.totalAmount) || 0);
  const maxRefundableInr = roundMoney2(Math.max(0, Math.min(netRefund, paidInr - alreadyRefundedInr)));

  return {
    eligible: maxRefundableInr > minRefundThreshold + 0.005,
    reason:
      maxRefundableInr > minRefundThreshold + 0.005
        ? eligibility.reason
        : maxRefundableInr <= 0
          ? 'zero_or_negative_net_refund'
          : 'refund_below_min_threshold',
    cartValue,
    orderTotal,
    minGateAmount,
    deductions,
    totalDeductions,
    netRefund,
    maxRefundableInr,
    alreadyRefundedInr,
    minOrderValue,
    minRefundThreshold,
    negativeNetBeforeClamp: rawNet < 0
  };
}

/**
 * Classify Shiprocket RTO reason — customer fault checked before courier.
 * Generic "RTO" / "return to origin" alone → unknown (not courier).
 * @param {string|null|undefined} providerStatus
 * @returns {'customer'|'courier'|'unknown'}
 */
function classifyRtoReasonCategory(providerStatus) {
  const ps = String(providerStatus || '').trim();
  if (!ps) return 'unknown';
  if (CUSTOMER_RTO_REASON_RE.test(ps)) return 'customer';
  if (COURIER_RTO_REASON_RE.test(ps)) return 'courier';
  return 'unknown';
}

/**
 * Mongo filter: customer-fault RTO (Shiprocket providerStatus).
 */
function buildCustomerRtoSectionMatch() {
  return {
    'shipmentInfo.providerStatus': { $regex: CUSTOMER_RTO_PROVIDER_REGEX, $options: 'i' }
  };
}

/**
 * Mongo filter: courier/logistics-fault RTO — excludes customer-fault labels.
 */
function buildCourierRtoSectionMatch() {
  return {
    $and: [
      { 'shipmentInfo.providerStatus': { $regex: COURIER_RTO_PROVIDER_REGEX, $options: 'i' } },
      {
        'shipmentInfo.providerStatus': {
          $not: { $regex: CUSTOMER_RTO_PROVIDER_REGEX, $options: 'i' }
        }
      }
    ]
  };
}

/**
 * True warehouse-delivered / received-at-seller status text (NOT "RTO Acknowledged").
 * Covers Shiprocket English labels + courier codes like `rts_d`
 * ("Item Return To Seller Delivered").
 * Acknowledged alone must never unlock refund.
 */
const RTO_WAREHOUSE_DELIVERED_STATUS_RE =
  /rto delivered|return delivered|delivered to seller|delivered to warehouse|rto received at warehouse|rto received|rto complete|returned to seller|shipment rto delivered|return to seller delivered|item return to seller delivered|rts delivered|\brts[\s_-]?d\b/i;

/**
 * Explicit non-delivered RTS / RTO codes (must not unlock refund).
 * e.g. rts_ofd = return out for delivery, not delivered to seller WH.
 */
const RTO_NOT_WAREHOUSE_DELIVERED_CODE_RE =
  /^(rto[\s_-]?acknowledged|acknowledged|rts[\s_-]?ofd|rts[\s_-]?in[\s_-]?process|rts[\s_-]?otp|received[\s_-]?at[\s_-]?rts[\s_-]?hub|rts)$/i;

/**
 * Shiprocket-driven RTO workflow stage (display).
 * Refund gate uses {@link isRtoWarehouseDeliveredForOrder} (latch + delivered evidence), not Acknowledged alone.
 * @param {string|null|undefined} providerStatus
 */
function mapShiprocketRtoStage(providerStatus) {
  try {
    const ps = String(providerStatus || '').toLowerCase();
    if (!ps) return 'rto_initiated';
    if (isRtoDeliveredToWarehouse(ps)) {
      return 'rto_delivered_to_warehouse';
    }
    if (
      (/\brto\b/.test(ps) || /\brts\b/.test(ps) || /return to seller|return to origin/.test(ps)) &&
      /in transit|picked up|out for (pickup|delivery)|reached destination hub|in\s*intransit|rts_ofd|received_at_rts_hub|rts_in_process/.test(
        ps
      )
    ) {
      return 'rto_in_transit';
    }
    if (/\brto\b/.test(ps) || /\brts\b/.test(ps) || /return to origin|return to seller/.test(ps)) {
      return 'rto_initiated';
    }
    return 'rto_initiated';
  } catch {
    return 'rto_initiated';
  }
}

/**
 * True when status / activity text means parcel delivered back to seller warehouse.
 * Safe for Shiprocket labels, courier codes (`rts_d`), and free-text activity lines.
 * Never true for Acknowledged-only or RTS in-transit codes.
 * @param {string|null|undefined} providerStatus
 */
function isRtoDeliveredToWarehouse(providerStatus) {
  try {
    const raw = String(providerStatus ?? '').trim();
    if (!raw) return false;

    const compact = raw.toLowerCase().replace(/[\s-]+/g, '_');
    if (RTO_NOT_WAREHOUSE_DELIVERED_CODE_RE.test(compact) || RTO_NOT_WAREHOUSE_DELIVERED_CODE_RE.test(raw)) {
      return false;
    }

    // Exact / bounded courier delivered codes (Orders tab: rts_d)
    if (/^rts_d$/i.test(compact) || /^rtsd$/i.test(compact)) {
      return true;
    }

    return RTO_WAREHOUSE_DELIVERED_STATUS_RE.test(raw);
  } catch {
    return false;
  }
}

/**
 * True when text looks like a Shiprocket RTO *status* label (not a fault reason).
 * @param {string|null|undefined} text
 */
function isLikelyRtoStatusLabel(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return true;
  if (
    /^(rto\s*)?(initiated|in\s*transit|in\s*intransit|delivered|acknowledged|out for pickup|picked up)(\s+to\s+warehouse)?$/i.test(
      t
    )
  ) {
    return true;
  }
  return /rto\s*(initiated|delivered|acknowledged|in\s*transit|in\s*intransit|complete)|return\s*to\s*origin|delivered\s*to\s*(seller|warehouse)/i.test(
    t
  );
}

/**
 * Collect status / activity strings used for warehouse-delivered evidence.
 * Includes normalized tracking `code` (Shiprocket stores sr_status as `code`, not only status_code).
 * @param {import('mongoose').Document|object} order
 * @returns {string[]}
 */
function collectRtoStatusTexts(order) {
  const texts = [];
  const push = (v) => {
    try {
      if (v == null) return;
      const s = String(v).trim();
      if (s) texts.push(s);
    } catch {
      /* ignore bad event field */
    }
  };
  try {
    push(order?.shipmentInfo?.providerStatus);
    push(order?.returnInfo?.rtoShiprocketReason);
    const events = Array.isArray(order?.shipmentInfo?.rawEvents) ? order.shipmentInfo.rawEvents : [];
    for (const ev of events) {
      if (!ev || typeof ev !== 'object') continue;
      push(ev.status);
      push(ev.current_status);
      push(ev.sr_status);
      push(ev['sr-status']);
      push(ev.code);
      push(ev.activity);
      push(ev.message);
      push(ev.description);
      push(ev.status_code);
      const raw = ev.raw && typeof ev.raw === 'object' ? ev.raw : null;
      if (raw) {
        push(raw.sr_status_label);
        push(raw.sr_status);
        push(raw.status);
        push(raw.status_code);
        push(raw.activity);
        push(raw.message);
      }
    }
  } catch {
    /* return whatever we collected */
  }
  return texts;
}

/**
 * True if current status OR tracking history ever showed real warehouse delivery.
 * "RTO Acknowledged" alone is NOT enough.
 * @param {import('mongoose').Document|object} order
 */
function orderHasRtoWarehouseDeliveredEvidence(order) {
  try {
    if (!order) return false;
    return collectRtoStatusTexts(order).some((t) => isRtoDeliveredToWarehouse(t));
  } catch {
    return false;
  }
}

/**
 * Order-level refund warehouse gate:
 * - latch set after real Delivered once, OR
 * - Delivered evidence in current status / rawEvents history
 * Never unlocks on Acknowledged-only.
 * @param {import('mongoose').Document|object} order
 */
function isRtoWarehouseDeliveredForOrder(order) {
  try {
    if (!order) return false;
    if (order.returnInfo?.rtoWarehouseDeliveredAt) return true;
    return orderHasRtoWarehouseDeliveredEvidence(order);
  } catch {
    return false;
  }
}

/**
 * Persist latch only when real Delivered evidence exists (not Acknowledged alone).
 * @param {import('mongoose').Document|object} order
 * @returns {boolean} whether returnInfo was mutated
 */
function ensureRtoWarehouseDeliveredLatch(order) {
  try {
    if (!order) return false;
    if (order.returnInfo?.rtoWarehouseDeliveredAt) return false;
    if (!orderHasRtoWarehouseDeliveredEvidence(order)) return false;
    if (!order.returnInfo) order.returnInfo = {};
    order.returnInfo.rtoWarehouseDeliveredAt = new Date();
    if (typeof order.markModified === 'function') {
      order.markModified('returnInfo');
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Logistics / scan noise — not an RTO fault reason (e.g. "Data Received").
 * @param {string|null|undefined} text
 */
function isRtoReasonNoise(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return true;
  if (t.length < 8) return true;
  if (
    /^(data received|manifested|shipment created|awb assigned|label generated|out for pickup|picked up|in transit|reached destination hub|bag received|out for delivery|rto initiated|rto acknowledged|rto in[- ]?transit)$/i.test(
      t
    )
  ) {
    return true;
  }
  if (/data received|item assigned for seller|bag received at|manifested\s*-|pickup scheduled|srpid-/i.test(t)) {
    return true;
  }
  return false;
}

/**
 * Prefer real NDR / customer-courier fault copy over scan noise.
 * @param {string|null|undefined} text
 */
function isLikelyNdrFaultReason(text) {
  const t = String(text || '').trim();
  if (!t || isLikelyRtoStatusLabel(t) || isRtoReasonNoise(t)) return false;
  if (CUSTOMER_RTO_REASON_RE.test(t) || COURIER_RTO_REASON_RE.test(t)) return true;
  // Sentence-like carrier remarks under NDR attempts
  if (/customer|consignee|address|attempt|refused|unavailable|not reachable|wrong|incomplete/i.test(t) && t.length >= 12) {
    return true;
  }
  return false;
}

/**
 * @param {object} ev
 * @returns {string[]}
 */
function collectEventReasonCandidates(ev) {
  const out = [];
  const push = (v) => {
    const s = String(v || '').trim();
    if (s) out.push(s);
  };
  if (!ev || typeof ev !== 'object') return out;
  push(ev.reason);
  push(ev.rto_reason);
  push(ev.ndr_reason);
  push(ev.remarks);
  push(ev.comment);
  push(ev.status_code_description);
  push(ev.description);
  push(ev.activity);
  push(ev.message);
  const raw = ev.raw && typeof ev.raw === 'object' ? ev.raw : null;
  if (raw) {
    push(raw.reason);
    push(raw.ndr_reason);
    push(raw.rto_reason);
    push(raw.remarks);
    push(raw.comment);
    push(raw.status_code_description);
    push(raw.activity);
    push(raw.message);
  }
  return out;
}

/**
 * Admin Reason column — prefer Shiprocket NDR / undelivered fault text; never echo
 * status labels or logistics noise like "Data Received".
 * @param {import('mongoose').Document|object} order
 * @returns {string}
 */
function resolveRtoDisplayReason(order) {
  const ri = order?.returnInfo || {};
  const providerStatus = order?.shipmentInfo?.providerStatus || null;

  const tryFault = (v) => {
    const s = String(v || '').trim();
    if (!s || isLikelyRtoStatusLabel(s) || isRtoReasonNoise(s)) return null;
    return s;
  };

  const fromStored = tryFault(ri.rtoShiprocketReason);
  if (fromStored && isLikelyNdrFaultReason(fromStored)) return fromStored;

  const events = Array.isArray(order?.shipmentInfo?.rawEvents) ? order.shipmentInfo.rawEvents : [];
  const ndrFaults = [];
  const otherFaults = [];

  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i] || {};
    const statusBlob = [ev.status, ev.description, ev.activity, ev.message, ev.ndrStatus]
      .map((x) => String(x || ''))
      .join(' ');
    const isNdrContext = /ndr|undelivered|rto initiated|delivery failed|attempt/i.test(statusBlob);

    for (const candidate of collectEventReasonCandidates(ev)) {
      const fault = tryFault(candidate);
      if (!fault) continue;
      if (isLikelyNdrFaultReason(fault) || isNdrContext) {
        if (isLikelyNdrFaultReason(fault)) ndrFaults.push(fault);
        else if (isNdrContext && fault.length >= 12) ndrFaults.push(fault);
        else otherFaults.push(fault);
      } else if (fault.length >= 16 && !isRtoReasonNoise(fault)) {
        otherFaults.push(fault);
      }
    }
  }

  if (ndrFaults.length) return ndrFaults[0];
  if (fromStored) return fromStored;
  if (otherFaults.length) return otherFaults[0];

  const cat =
    ri.rtoReasonCategory ||
    classifyRtoReasonCategory(ri.rtoShiprocketReason || providerStatus);
  if (cat === 'customer') return 'Customer-related RTO';
  if (cat === 'courier') return 'Courier / logistics related RTO';
  return 'Reason not provided by carrier';
}

/**
 * After Shiprocket tracking sync: latch warehouse Delivered + persist best NDR reason.
 * Safe to call on lean or mongoose docs; mutates returnInfo when needed.
 * @param {import('mongoose').Document|object} order
 * @returns {boolean} whether returnInfo changed
 */
function persistRtoTrackingInsights(order) {
  if (!order) return false;
  let changed = ensureRtoWarehouseDeliveredLatch(order);

  const display = resolveRtoDisplayReason(order);
  const usable =
    display &&
    display !== 'Reason not provided by carrier' &&
    display !== 'Customer-related RTO' &&
    display !== 'Courier / logistics related RTO' &&
    !isLikelyRtoStatusLabel(display) &&
    !isRtoReasonNoise(display);

  if (usable) {
    if (!order.returnInfo) order.returnInfo = {};
    const prev = String(order.returnInfo.rtoShiprocketReason || '').trim();
    const shouldReplace =
      !prev || isLikelyRtoStatusLabel(prev) || isRtoReasonNoise(prev) || !isLikelyNdrFaultReason(prev);
    if (shouldReplace && prev !== display) {
      order.returnInfo.rtoShiprocketReason = display;
      changed = true;
    }
    const cat = classifyRtoReasonCategory(
      shouldReplace && prev !== display ? display : prev || display
    );
    if (cat !== 'unknown' && order.returnInfo.rtoReasonCategory !== cat) {
      order.returnInfo.rtoReasonCategory = cat;
      changed = true;
    }
  }

  if (changed && typeof order.markModified === 'function') {
    order.markModified('returnInfo');
  }
  return changed;
}

/**
 * @param {string|null|undefined} providerStatus
 */
function classifyRtoReasonLabel(providerStatus) {
  const ps = String(providerStatus || '').trim();
  if (!ps) return 'RTO';
  if (isLikelyRtoStatusLabel(ps)) return 'Reason not provided by carrier';
  return ps;
}

/**
 * Admin-facing payment type for RTO list.
 * @param {import('mongoose').Document|object} order
 */
function classifyRtoPaymentType(order) {
  const method = String(order?.paymentInfo?.method || '').toLowerCase();
  const status = String(order?.paymentStatus || '').toLowerCase();
  const total = roundMoney2(Number(order?.totalAmount) || 0);
  const paid = roundMoney2(Number(order?.amountPaidInr) || 0);

  if (method === 'cod') {
    return {
      key: 'cod',
      label: 'COD',
      detail: 'Cash on delivery — no refund',
      refundAllowed: false
    };
  }

  if (status === 'paid' && paid + 0.005 >= total) {
    return {
      key: 'full_paid',
      label: 'Fully Paid',
      detail: `Online — ₹${paid} paid in full`,
      refundAllowed: true
    };
  }

  if (status === 'partially_paid' || (paid > 0.01 && paid + 0.005 < total)) {
    return {
      key: 'partial_paid',
      label: 'Partial Paid',
      detail: `Online — ₹${paid} of ₹${total}`,
      refundAllowed: false
    };
  }

  return {
    key: 'unpaid',
    label: 'Not fully paid',
    detail: status ? `Status: ${status}` : 'Payment incomplete',
    refundAllowed: false
  };
}

/**
 * @param {import('mongoose').Document|object} order
 */
function deriveRefundTrackStatus(order) {
  const ri = order?.returnInfo || {};
  if (ri.rtoRefundError) return 'failed';
  if (ri.rtoStatus === 'refunded') return 'completed';
  if (ri.rtoStatus === 'refund_failed') return 'failed';

  const rtoRefundEntry = (order?.refundHistory || []).find(
    (r) => String(r.reason || '').includes('rto') || r.refundId === ri.rtoRefundId
  );
  if (rtoRefundEntry) {
    const st = String(rtoRefundEntry.status || '').toLowerCase();
    if (st === 'processed' || st === 'completed') return 'completed';
    if (st === 'failed') return 'failed';
    return 'processing';
  }
  if (ri.rtoRefundId || ri.refundInitiatedAt) return 'initiated';
  return null;
}

/**
 * Sync rtoStatus from refund history / Razorpay webhook side-effects (read-only heal).
 * @param {import('mongoose').Document|object} order
 * @returns {boolean} whether order was mutated
 */
function syncRtoRefundStatusFromOrder(order) {
  if (!order?.returnInfo) {
    order.returnInfo = {};
  }
  const ri = order.returnInfo;
  if (['resolved', 'closed', 'refund_rejected'].includes(String(ri.rtoStatus || '').toLowerCase())) return false;

  let changed = false;
  if (!ri.rtoStatus) {
    ri.rtoStatus = 'pending';
    changed = true;
  }

  const track = deriveRefundTrackStatus(order);
  if (track === 'completed' && ri.rtoStatus !== 'refunded') {
    ri.rtoStatus = 'refunded';
    if (!ri.rtoRefundedAt) ri.rtoRefundedAt = new Date();
    changed = true;
  } else if (track === 'failed' && ri.rtoStatus !== 'refund_failed') {
    ri.rtoStatus = 'refund_failed';
    changed = true;
  }

  return changed;
}

/**
 * Mongo regex for true warehouse-delivered RTO (list filters).
 * Acknowledged / rts_ofd / hub-only codes are excluded from this pattern.
 */
const RTO_WAREHOUSE_DELIVERED_REGEX =
  'rto delivered|return delivered|delivered to seller|delivered to warehouse|rto received at warehouse|rto received|rto complete|returned to seller|shipment rto delivered|return to seller delivered|item return to seller delivered|rts delivered|rts_d|rts-d';

/**
 * @param {object|null|undefined} ri
 * @returns {object}
 */
function toPlainReturnInfo(ri) {
  if (!ri) return {};
  if (typeof ri.toObject === 'function') return ri.toObject();
  return { ...ri };
}

/**
 * Merge returnInfo without writing `undefined` (prevents Mongoose cast errors).
 * @param {object|null|undefined} existing
 * @param {object} patch
 */
function mergeReturnInfo(existing, patch = {}) {
  const base = toPlainReturnInfo(existing);
  const merged = { ...base, ...patch };
  const out = {};
  for (const [k, v] of Object.entries(merged)) {
    if (v !== undefined) out[k] = v;
  }
  const d = patch.rtoDeductions ?? base.rtoDeductions;
  if (d && typeof d === 'object') {
    out.rtoDeductions = {
      forwardShipping: Number(d.forwardShipping) || 0,
      rtoShipping: Number(d.rtoShipping) || 0,
      platformFee: Number(d.platformFee) || 0,
      platformFeePercent: Number(d.platformFeePercent) || 0,
      orderTotal: Number(d.orderTotal) || 0,
      cartValue: Number(d.cartValue) || 0
    };
  } else if (out.rtoDeductions === undefined) {
    delete out.rtoDeductions;
  }
  return out;
}

/**
 * @param {import('mongoose').Document|object} order
 * @returns {boolean}
 */
function isFullOnlinePaidOrder(order) {
  const pay = classifyRtoPaymentType(order);
  return pay.key === 'full_paid';
}

/**
 * @param {import('mongoose').Document|object} order
 * @returns {boolean}
 */
function isPartialPaidOnlineOrder(order) {
  const pay = classifyRtoPaymentType(order);
  return pay.key === 'partial_paid';
}

/**
 * @param {import('mongoose').Document|object} order
 * @returns {boolean}
 */
function hasRtoRefundBeenInitiated(order) {
  const ri = order?.returnInfo || {};
  return Boolean(
    (ri.rtoRefundId && String(ri.rtoRefundId).trim()) ||
      ri.refundInitiatedAt ||
      (order?.refundHistory || []).some((r) => String(r.reason || '').includes('rto'))
  );
}

module.exports = {
  calculatePlatformFee,
  calculateRtoRefund,
  getRtoOrderTotal,
  getOrderAmountForRtoMinGate,
  getMinOrderValueForRefund,
  getMinRefundThreshold,
  classifyRtoRefundEligibility,
  classifyRtoReasonCategory,
  classifyRtoReasonLabel,
  mapShiprocketRtoStage,
  isRtoDeliveredToWarehouse,
  isRtoWarehouseDeliveredForOrder,
  ensureRtoWarehouseDeliveredLatch,
  persistRtoTrackingInsights,
  resolveRtoDisplayReason,
  isLikelyRtoStatusLabel,
  classifyRtoPaymentType,
  deriveRefundTrackStatus,
  syncRtoRefundStatusFromOrder,
  getForwardShippingFromOrder,
  getRtoShippingFromOrder,
  orderNeedsRtoFreightSync,
  applyRtoFreightChargeToOrder,
  syncRtoFreightChargeFromShiprocket,
  enrichRtoOrdersFreightCharges,
  toPlainReturnInfo,
  mergeReturnInfo,
  isFullOnlinePaidOrder,
  isPartialPaidOnlineOrder,
  hasRtoRefundBeenInitiated,
  RTO_WAREHOUSE_DELIVERED_REGEX,
  CUSTOMER_RTO_PROVIDER_REGEX,
  COURIER_RTO_PROVIDER_REGEX,
  buildCustomerRtoSectionMatch,
  buildCourierRtoSectionMatch,
  CUSTOMER_RTO_REASON_RE,
  COURIER_RTO_REASON_RE
};
