/**
 * OOS pending-order shipping settlement (accept-se-pehle item edit).
 *
 * Apply pe shipping drop pe turant refund nahi — purani delivery hold.
 * Ship Now (real AWB + courier freight) ke baad excess refund.
 *
 * Scope: online/prepaid captured orders only. COD / empty-cancel / other flows untouched.
 */
const Razorpay = require('razorpay');
const logger = require('../utils/logger');
const { roundMoney2 } = require('./checkoutComputation.service');
const ShiprocketService = require('../utils/shiprocket');
const { mergeReturnInfo } = require('./rtoRefund.service');
const { pickCheapestActiveCourier } = require('./courierPolicy.service');

const razorpay =
  String(process.env.RAZORPAY_KEY_ID || '').trim() && String(process.env.RAZORPAY_KEY_SECRET || '').trim()
    ? new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET
      })
    : null;

function isOnlineCapturedMethod(order) {
  const method = String(order?.paymentInfo?.method || '').toLowerCase();
  return method === 'online' || method === 'prepaid';
}

function sumRefundHistoryInr(order) {
  return roundMoney2(
    (order?.refundHistory || []).reduce((s, r) => s + (Number(r.amountInr) || 0), 0)
  );
}

function netCapturedInr(order) {
  const paid = roundMoney2(Number(order?.amountPaidInr) || 0);
  return roundMoney2(Math.max(0, paid - sumRefundHistoryInr(order)));
}

/**
 * True when Apply should keep previous deliveryCharges and defer shipping refund.
 * @param {object} order
 * @param {{ oldDelivery: number }} priced
 */
function shouldDeferShippingSettlement(order, priced) {
  if (!isOnlineCapturedMethod(order)) return false;
  const oldDelivery = roundMoney2(Number(priced?.oldDelivery) || 0);
  if (!(oldDelivery > 0.005)) return false;

  const pay = String(order?.paymentStatus || '').toLowerCase();
  const captured = ['paid', 'partially_paid', 'partially_refunded'].includes(pay);
  const paidAmt = roundMoney2(Number(order?.amountPaidInr) || 0);
  if (!captured && !(paidAmt > 0.01)) return false;

  return true;
}

/**
 * @param {object} order
 * @param {object} priced - from repriceShippingForItems
 */
function buildOosShippingSettlementMeta(order, priced) {
  return {
    pending: true,
    heldDeliveryCharges: roundMoney2(Number(priced.oldDelivery) || 0),
    provisionalQuotedDelivery: roundMoney2(Number(priced.quotedDelivery) || 0),
    provisionalQuotedMock: Boolean(priced.shipMeta?.mock),
    provisionalCourierName: priced.shippingSnapshot?.courierName || null,
    itemsSubtotal: roundMoney2(Number(priced.subtotal) || 0),
    tax: roundMoney2(Number(priced.tax) || 0),
    discount: roundMoney2(Number(priced.discount) || 0),
    createdAt: new Date().toISOString()
  };
}

/**
 * Resolve live courier freight for an assigned courier id (Ship Now).
 * @returns {Promise<{ ok: boolean, freightInr: number|null, mock: boolean, message?: string }>}
 */
async function resolveActualFreightForCourier(order, courierId) {
  const cid = Number(courierId);
  if (!Number.isFinite(cid)) {
    return { ok: false, freightInr: null, mock: false, message: 'courierId required' };
  }

  if (!ShiprocketService.enabled) {
    return { ok: false, freightInr: null, mock: true, message: 'Shiprocket disabled — cannot settle on mock freight' };
  }

  try {
    const parts = await ShiprocketService.buildAdhocPayloadParts(order);
    const deliveryPin = String(parts.addr?.postalCode || '').replace(/\D/g, '').slice(0, 6);
    if (deliveryPin.length !== 6) {
      return { ok: false, freightInr: null, mock: false, message: 'Invalid delivery pincode' };
    }

    const listRes = await ShiprocketService.listCouriersForRoute(deliveryPin, {
      weightKg: parts.totalWeight,
      lengthCm: parts.maxL,
      widthCm: parts.maxB,
      heightCm: parts.maxH,
      codAmount: parts.codAmountForQuote
    });
    if (!listRes.success || !Array.isArray(listRes.couriers)) {
      return {
        ok: false,
        freightInr: null,
        mock: Boolean(listRes.mock),
        message: listRes.message || 'Courier list failed'
      };
    }

    const match =
      listRes.couriers.find((c) => {
        const id = Number(c?.courier_company_id ?? c?.id ?? c?.courier_id);
        return Number.isFinite(id) && id === cid;
      }) || null;

    if (!match) {
      // Fallback: cheapest active (same policy as Ship Now) if id missing from list
      const picked = pickCheapestActiveCourier(listRes.couriers || [], {
        codRequired: parts.useCodAtDoor
      });
      if (!picked?.courier) {
        return { ok: false, freightInr: null, mock: false, message: 'Courier not found in serviceability list' };
      }
      const split = ShiprocketService.extractShippingChargeSplit(
        picked.courier,
        Number(picked.courier.rate ?? picked.courier.freight_charge) || 0
      );
      return {
        ok: true,
        freightInr: roundMoney2(Number(split.deliveryCharges) || 0),
        mock: false,
        message: 'used_cheapest_fallback'
      };
    }

    const split = ShiprocketService.extractShippingChargeSplit(
      match,
      Number(match.rate ?? match.freight_charge) || 0
    );
    return {
      ok: true,
      freightInr: roundMoney2(Number(split.deliveryCharges) || 0),
      mock: false
    };
  } catch (err) {
    logger.error('[oosShippingSettlement] resolveActualFreightForCourier failed', {
      orderId: order?.orderId,
      message: err?.message || String(err)
    });
    return { ok: false, freightInr: null, mock: false, message: err?.message || String(err) };
  }
}

async function attemptSettlementRefund(order, refundInr, reason) {
  if (!(refundInr > 0.005)) {
    return { refundAttempted: false, refund: null, warning: null };
  }
  const paymentId = order.paymentInfo?.razorpayPaymentId;
  if (!paymentId || !razorpay) {
    return {
      refundAttempted: false,
      refund: null,
      warning: 'Shipping settlement refund due but Razorpay is not configured or payment id is missing.'
    };
  }

  const paise = Math.round(refundInr * 100);
  if (paise < 1) {
    return { refundAttempted: false, refund: null, warning: null };
  }

  try {
    const refund = await razorpay.payments.refund(paymentId, {
      amount: paise,
      speed: 'normal',
      notes: {
        orderId: order.orderId,
        reason: reason || 'oos_shipping_settled_after_ship_now'
      }
    });

    const amountPaise = Number(refund.amount);
    const amountInr = roundMoney2(amountPaise / 100);
    order.refundHistory = order.refundHistory || [];
    if (!order.refundHistory.some((r) => r.refundId === refund.id)) {
      order.refundHistory.push({
        refundId: refund.id,
        amountInr,
        amountPaise,
        status: refund.status || 'processed',
        reason: reason || 'oos_shipping_settled_after_ship_now',
        createdAt: new Date()
      });
    }
    order.markModified('refundHistory');
    return { refundAttempted: true, refund, warning: null };
  } catch (err) {
    logger.error('[oosShippingSettlement] refund failed', {
      orderId: order?.orderId,
      message: err?.message || String(err)
    });
    return {
      refundAttempted: true,
      refund: null,
      warning: err?.error?.description || err?.message || 'Refund API failed'
    };
  }
}

/**
 * After Ship Now AWB: set customer delivery = min(held, actual), refund excess.
 * No-ops when flag absent / mock freight / invalid.
 *
 * @param {import('mongoose').Document} order
 * @param {{ actualFreightInr?: number|null, mock?: boolean, courierId?: number|null, courierName?: string|null, source?: string }} opts
 */
async function settleOosShippingAfterActualFreight(order, opts = {}) {
  if (!order) {
    return { settled: false, skipped: true, reason: 'no_order' };
  }

  const meta = order.paymentInfo?.oosShippingSettlement;
  if (!meta || meta.pending !== true) {
    return { settled: false, skipped: true, reason: 'not_pending' };
  }

  if (opts.mock) {
    return { settled: false, skipped: true, reason: 'mock_freight' };
  }

  const actualFreightInr = roundMoney2(Number(opts.actualFreightInr));
  if (!Number.isFinite(actualFreightInr) || actualFreightInr < 0) {
    return { settled: false, skipped: true, reason: 'invalid_freight' };
  }

  const held = roundMoney2(
    Number(meta.heldDeliveryCharges != null ? meta.heldDeliveryCharges : order.deliveryCharges) || 0
  );
  // Never charge customer more than shipping already held from checkout / pre-edit.
  const customerDelivery = roundMoney2(Math.min(held, actualFreightInr));

  const subtotal = roundMoney2(Number(order.subtotal) || 0);
  const tax = roundMoney2(Number(order.tax) || 0);
  const discount = roundMoney2(Number(order.discount) || 0);
  const newTotal = roundMoney2(subtotal + customerDelivery + tax - discount);

  const paid = roundMoney2(Number(order.amountPaidInr) || 0);
  const alreadyRefunded = sumRefundHistoryInr(order);
  // amountPaidInr on this codebase is typically "net still attributed to order" after prior amendment refunds.
  // Prefer amountPaidInr as the ceiling for remaining settlement refund.
  const refundablePool = roundMoney2(Math.max(0, paid));
  const refundInr = roundMoney2(Math.max(0, Math.min(refundablePool, paid - newTotal)));

  const beforeDelivery = roundMoney2(Number(order.deliveryCharges) || 0);
  const beforeTotal = roundMoney2(Number(order.totalAmount) || 0);

  order.deliveryCharges = customerDelivery;
  order.totalAmount = newTotal;
  order.paymentInfo = order.paymentInfo || {};
  order.paymentInfo.fullOrderAmountPaise = Math.round(newTotal * 100);
  order.paymentInfo.oosShippingSettlement = {
    ...meta,
    pending: false,
    settledAt: new Date().toISOString(),
    actualFreightInr,
    customerDelivery,
    courierId: opts.courierId != null ? Number(opts.courierId) : null,
    courierName: opts.courierName || null,
    source: opts.source || 'ship_now',
    refundInr
  };
  order.markModified('paymentInfo');

  if (order.shippingSnapshot && typeof order.shippingSnapshot === 'object') {
    if (opts.courierName) order.shippingSnapshot.courierName = opts.courierName;
    if (opts.courierId != null && Number.isFinite(Number(opts.courierId))) {
      order.shippingSnapshot.courierCompanyId = Number(opts.courierId);
    }
    order.markModified('shippingSnapshot');
  }

  let refundWarning = null;
  if (refundInr > 0.005) {
    const refundOutcome = await attemptSettlementRefund(
      order,
      refundInr,
      'oos_shipping_settled_after_ship_now'
    );
    refundWarning = refundOutcome.warning;
    if (refundOutcome.refund && !refundOutcome.warning) {
      order.amountPaidInr = newTotal;
      order.balanceDueInr = 0;
      order.paymentStatus = 'paid';
      order.returnInfo = mergeReturnInfo(order.returnInfo, {
        refundContext: 'cancellation',
        status: 'partially_refunded',
        refundAmount: sumRefundHistoryInr(order),
        refundId: refundOutcome.refund.id
      });
      order.markModified('returnInfo');
    } else if (refundOutcome.warning) {
      order.paymentInfo.oosShippingSettlementRefundFailure = refundOutcome.warning;
      order.markModified('paymentInfo');
    }
  } else if (paid + 0.005 >= newTotal) {
    // Freight >= held (or equal): bill may drop only when actual < held already applied above.
    order.amountPaidInr = newTotal;
    order.balanceDueInr = 0;
    const ps = String(order.paymentStatus || '').toLowerCase();
    if (ps === 'partially_paid' || ps === 'paid' || ps === 'partially_refunded') {
      order.paymentStatus = 'paid';
    }
  }

  order.adminEditHistory = order.adminEditHistory || [];
  order.adminEditHistory.push({
    action: 'oos_shipping_settled_after_ship_now',
    note: 'Shipping settled against actual Shiprocket freight after Ship Now',
    performedBy: null,
    createdAt: new Date(),
    before: { deliveryCharges: beforeDelivery, totalAmount: beforeTotal, amountPaidInr: paid },
    after: {
      deliveryCharges: customerDelivery,
      totalAmount: newTotal,
      amountPaidInr: roundMoney2(Number(order.amountPaidInr) || 0)
    },
    metadata: {
      heldDeliveryCharges: held,
      actualFreightInr,
      customerDelivery,
      refundInr,
      refundWarning,
      courierId: opts.courierId ?? null,
      courierName: opts.courierName || null,
      alreadyRefundedInr: alreadyRefunded
    }
  });
  order.markModified('adminEditHistory');

  const noteMsg =
    refundInr > 0.005
      ? `Shipping was finalized after courier assignment. A refund of ₹${refundInr.toFixed(2)} was processed for the unused shipping amount.`
      : `Shipping was finalized after courier assignment at ₹${customerDelivery.toFixed(2)}.`;

  order.customerFacingNotes = order.customerFacingNotes || [];
  order.customerFacingNotes.push({
    message: noteMsg,
    kind: 'oos_shipping_settled',
    createdAt: new Date(),
    metadata: {
      heldDeliveryCharges: held,
      actualFreightInr,
      customerDelivery,
      refundInr
    }
  });
  order.markModified('customerFacingNotes');

  await order.save();

  logger.info('[oosShippingSettlement] settled after ship now', {
    orderId: order.orderId,
    held,
    actualFreightInr,
    customerDelivery,
    newTotal,
    refundInr,
    refundWarning
  });

  return {
    settled: true,
    skipped: false,
    refundInr,
    refundWarning,
    customerDelivery,
    actualFreightInr,
    newTotal
  };
}

module.exports = {
  shouldDeferShippingSettlement,
  buildOosShippingSettlementMeta,
  resolveActualFreightForCourier,
  settleOosShippingAfterActualFreight,
  netCapturedInr,
  isOnlineCapturedMethod
};
