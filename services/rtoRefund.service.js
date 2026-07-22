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
 * @param {import('mongoose').Document|object} order
 * @returns {number}
 */
function getForwardShippingFromOrder(order) {
  return roundMoney2(Number(order?.deliveryCharges) || 0);
}

/**
 * RTO return freight from Shiprocket payload fields when present.
 * @param {import('mongoose').Document|object} order
 * @returns {number}
 */
function getRtoShippingFromOrder(order) {
  const si = order?.shipmentInfo || {};
  const stored = order?.returnInfo?.rtoDeductions?.rtoShipping;
  if (stored != null && Number.isFinite(Number(stored))) {
    return roundMoney2(Number(stored));
  }

  const candidates = [si.rtoFreightCharge, si.rtoShippingCharge, si.rto_charge, si.freight_charge_rto];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n >= 0) return roundMoney2(n);
  }

  const events = Array.isArray(si.rawEvents) ? si.rawEvents : [];
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i] || {};
    const freight = ev.rto_freight ?? ev.freight_charge ?? ev.rto_charge;
    const n = Number(freight);
    if (Number.isFinite(n) && n >= 0) return roundMoney2(n);
  }

  const envDefault = Number(process.env.RTO_DEFAULT_SHIPPING_CHARGE);
  if (Number.isFinite(envDefault) && envDefault >= 0) {
    return roundMoney2(envDefault);
  }
  return 0;
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

  if (orderTotal + 0.005 < minOrderValue) {
    return buildBlocked('order_below_min_value', { orderTotalBelowMin: true });
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
 * Acknowledged can appear earlier in the RTO lifecycle and must not unlock refund alone.
 */
const RTO_WAREHOUSE_DELIVERED_STATUS_RE =
  /rto delivered|return delivered|delivered to seller|delivered to warehouse|rto received at warehouse|rto received|rto complete|returned to seller|shipment rto delivered/i;

/**
 * Shiprocket-driven RTO workflow stage (display).
 * Refund gate uses {@link isRtoWarehouseDeliveredForOrder} (latch + delivered evidence), not Acknowledged alone.
 * @param {string|null|undefined} providerStatus
 */
function mapShiprocketRtoStage(providerStatus) {
  const ps = String(providerStatus || '').toLowerCase();
  if (!ps) return 'rto_initiated';
  if (RTO_WAREHOUSE_DELIVERED_STATUS_RE.test(ps)) {
    return 'rto_delivered_to_warehouse';
  }
  if (/\brto\b/.test(ps) && /in transit|picked up|out for pickup|reached destination hub|in\s*intransit/.test(ps)) {
    return 'rto_in_transit';
  }
  if (/\brto\b/.test(ps) || /return to origin/.test(ps)) {
    return 'rto_initiated';
  }
  return 'rto_initiated';
}

/**
 * @param {string|null|undefined} providerStatus
 */
function isRtoDeliveredToWarehouse(providerStatus) {
  return RTO_WAREHOUSE_DELIVERED_STATUS_RE.test(String(providerStatus || ''));
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
 * @param {import('mongoose').Document|object} order
 * @returns {string[]}
 */
function collectRtoStatusTexts(order) {
  const texts = [];
  const push = (v) => {
    const s = String(v || '').trim();
    if (s) texts.push(s);
  };
  push(order?.shipmentInfo?.providerStatus);
  push(order?.returnInfo?.rtoShiprocketReason);
  const events = Array.isArray(order?.shipmentInfo?.rawEvents) ? order.shipmentInfo.rawEvents : [];
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    push(ev.status);
    push(ev.current_status);
    push(ev.sr_status);
    push(ev['sr-status']);
    push(ev.activity);
    push(ev.message);
    push(ev.status_code);
  }
  return texts;
}

/**
 * True if current status OR tracking history ever showed real warehouse delivery.
 * "RTO Acknowledged" alone is NOT enough.
 * @param {import('mongoose').Document|object} order
 */
function orderHasRtoWarehouseDeliveredEvidence(order) {
  return collectRtoStatusTexts(order).some((t) => isRtoDeliveredToWarehouse(t));
}

/**
 * Order-level refund warehouse gate:
 * - latch set after real Delivered once, OR
 * - Delivered evidence in current status / rawEvents history
 * Never unlocks on Acknowledged-only.
 * @param {import('mongoose').Document|object} order
 */
function isRtoWarehouseDeliveredForOrder(order) {
  if (!order) return false;
  if (order.returnInfo?.rtoWarehouseDeliveredAt) return true;
  return orderHasRtoWarehouseDeliveredEvidence(order);
}

/**
 * Persist latch only when real Delivered evidence exists (not Acknowledged alone).
 * @param {import('mongoose').Document|object} order
 * @returns {boolean} whether returnInfo was mutated
 */
function ensureRtoWarehouseDeliveredLatch(order) {
  if (!order) return false;
  if (order.returnInfo?.rtoWarehouseDeliveredAt) return false;
  if (!orderHasRtoWarehouseDeliveredEvidence(order)) return false;
  if (!order.returnInfo) order.returnInfo = {};
  order.returnInfo.rtoWarehouseDeliveredAt = new Date();
  if (typeof order.markModified === 'function') {
    order.markModified('returnInfo');
  }
  return true;
}

/**
 * Admin Reason column — never echo raw Shiprocket status labels.
 * @param {import('mongoose').Document|object} order
 * @returns {string}
 */
function resolveRtoDisplayReason(order) {
  const ri = order?.returnInfo || {};
  const providerStatus = order?.shipmentInfo?.providerStatus || null;

  const tryText = (v) => {
    const s = String(v || '').trim();
    if (!s || isLikelyRtoStatusLabel(s)) return null;
    return s;
  };

  const fromStored = tryText(ri.rtoShiprocketReason);
  if (fromStored) return fromStored;

  const events = Array.isArray(order?.shipmentInfo?.rawEvents) ? order.shipmentInfo.rawEvents : [];
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i] || {};
    const candidate =
      tryText(ev.reason) ||
      tryText(ev.rto_reason) ||
      tryText(ev.remarks) ||
      tryText(ev.comment) ||
      tryText(ev.status_code_description) ||
      tryText(ev.description);
    if (candidate) return candidate;
  }

  const cat =
    ri.rtoReasonCategory ||
    classifyRtoReasonCategory(ri.rtoShiprocketReason || providerStatus);
  if (cat === 'customer') return 'Customer-related RTO';
  if (cat === 'courier') return 'Courier / logistics related RTO';
  return 'Reason not provided by carrier';
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

/** Mongo regex for true warehouse-delivered RTO (list filters). Acknowledged is excluded. */
const RTO_WAREHOUSE_DELIVERED_REGEX =
  'rto delivered|return delivered|delivered to seller|delivered to warehouse|rto received at warehouse|rto received|rto complete|returned to seller|shipment rto delivered';

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
  getMinOrderValueForRefund,
  getMinRefundThreshold,
  classifyRtoRefundEligibility,
  classifyRtoReasonCategory,
  classifyRtoReasonLabel,
  mapShiprocketRtoStage,
  isRtoDeliveredToWarehouse,
  isRtoWarehouseDeliveredForOrder,
  ensureRtoWarehouseDeliveredLatch,
  resolveRtoDisplayReason,
  isLikelyRtoStatusLabel,
  classifyRtoPaymentType,
  deriveRefundTrackStatus,
  syncRtoRefundStatusFromOrder,
  getForwardShippingFromOrder,
  getRtoShippingFromOrder,
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
