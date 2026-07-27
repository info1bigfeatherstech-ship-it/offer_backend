/**
 * OOS pending-order money settlement (accept-se-pehle item edit).
 *
 * Policy (production):
 * - Online/prepaid captured: Apply pe Razorpay refund NAHI — items update + shipping hold.
 * - Ship Now (real AWB) pe final bill =
 *     remainingItems + freight + tax − discount
 *   freight = actual courier rate if > 0, else held checkout shipping if > 0;
 *   freight 0 only when checkout held shipping was 0 (free ship) and AWB exists.
 *   Missing/failed courier rate must NEVER be treated as 0 when held ship > 0
 *   (that caused over-refund of shipping on prepaid OOS).
 * - Refund = max(0, amountPaid − finalBill)
 * - Customer se kabhi EXTRA nahi: balanceDue / COD kabhi increase nahi.
 * - Shortfall → merchant absorb.
 * - Razorpay refund BEFORE totals mutate; refundHistory early-persist + updateOne fallback.
 */
const Razorpay = require('razorpay');
const Order = require('../models/Order');
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

const MIN_POSITIVE_FREIGHT_INR = 0.01;

function isOnlineCapturedMethod(order) {
  const method = String(order?.paymentInfo?.method || '').toLowerCase();
  return method === 'online' || method === 'prepaid';
}

function sumRefundHistoryInr(order) {
  return roundMoney2(
    (order?.refundHistory || []).reduce((s, r) => s + (Number(r.amountInr) || 0), 0)
  );
}

/** First candidate that is a finite freight strictly above MIN_POSITIVE_FREIGHT_INR. */
function pickPositiveFreightInr(...candidates) {
  for (const c of candidates) {
    if (c == null || c === '') continue;
    const n = roundMoney2(Number(c));
    if (Number.isFinite(n) && n >= MIN_POSITIVE_FREIGHT_INR) return n;
  }
  return null;
}

/**
 * Defer money settlement until Ship Now for online/prepaid with capture.
 */
function shouldDeferShippingSettlement(order) {
  if (!isOnlineCapturedMethod(order)) return false;
  const pay = String(order?.paymentStatus || '').toLowerCase();
  const captured = ['paid', 'partially_paid', 'partially_refunded'].includes(pay);
  const paidAmt = roundMoney2(Number(order?.amountPaidInr) || 0);
  if (!captured && !(paidAmt > 0.01)) return false;
  return true;
}

/**
 * Apply-time money: no refund; due never rises above pre-edit due.
 */
function computeDeferredApplyFinancials(order, provisionalTotal) {
  const paid = roundMoney2(Number(order?.amountPaidInr) || 0);
  const priorDue = roundMoney2(Number(order?.balanceDueInr) || 0);
  const total = roundMoney2(Number(provisionalTotal) || 0);
  const idealDue = roundMoney2(Math.max(0, total - paid));
  const balanceDueInr = roundMoney2(Math.min(priorDue, idealDue));
  const paymentStatus =
    balanceDueInr > 0.005
      ? 'partially_paid'
      : paid > 0.01
        ? 'paid'
        : String(order?.paymentStatus || 'pending');

  return {
    refundInr: 0,
    amountPaidInr: paid,
    balanceDueInr,
    paymentStatus,
    provisionalTotal: total,
    priorDue,
    idealDue,
    dueCapped: idealDue > priorDue + 0.005
  };
}

/**
 * Final settle math after positive freight (pure — no I/O).
 */
function computeFinalOosSettlement(input) {
  const subtotal = roundMoney2(Number(input.subtotal) || 0);
  const tax = roundMoney2(Number(input.tax) || 0);
  const discount = roundMoney2(Number(input.discount) || 0);
  const freightInr = roundMoney2(Number(input.actualFreightInr) || 0);
  const amountPaidInr = roundMoney2(Number(input.amountPaidInr) || 0);
  const maxBalanceDueInr = roundMoney2(Math.max(0, Number(input.maxBalanceDueInr) || 0));

  const allowZero = Boolean(input.allowZeroFreight);
  if (!Number.isFinite(freightInr) || freightInr < 0) {
    return {
      ok: false,
      reason: 'freight_invalid',
      customerDelivery: 0,
      newTotal: 0,
      refundInr: 0,
      balanceDueInr: 0,
      idealDue: 0,
      absorbedShortfallInr: 0,
      paymentStatus: null,
      nextAmountPaidInr: amountPaidInr,
      amountPaidInr
    };
  }
  if (freightInr < MIN_POSITIVE_FREIGHT_INR && !allowZero) {
    return {
      ok: false,
      reason: 'freight_not_positive',
      customerDelivery: 0,
      newTotal: 0,
      refundInr: 0,
      balanceDueInr: 0,
      idealDue: 0,
      absorbedShortfallInr: 0,
      paymentStatus: null,
      nextAmountPaidInr: amountPaidInr,
      amountPaidInr
    };
  }

  const customerDelivery = freightInr;
  const newTotal = roundMoney2(subtotal + customerDelivery + tax - discount);
  const refundInr = roundMoney2(Math.max(0, Math.min(amountPaidInr, amountPaidInr - newTotal)));
  const idealDue = roundMoney2(Math.max(0, newTotal - amountPaidInr));
  const balanceDueInr = roundMoney2(Math.min(maxBalanceDueInr, idealDue));
  const absorbedShortfallInr = roundMoney2(Math.max(0, idealDue - balanceDueInr));

  let paymentStatus;
  let nextAmountPaidInr = amountPaidInr;
  if (refundInr > 0.005) {
    nextAmountPaidInr = newTotal;
    paymentStatus = 'paid';
  } else if (amountPaidInr + 0.005 >= newTotal) {
    nextAmountPaidInr = newTotal;
    paymentStatus = 'paid';
  } else if (balanceDueInr > 0.005) {
    paymentStatus = 'partially_paid';
  } else {
    paymentStatus = amountPaidInr > 0.01 ? 'paid' : 'partially_paid';
  }

  return {
    ok: true,
    reason: null,
    customerDelivery,
    newTotal,
    refundInr,
    balanceDueInr,
    idealDue,
    absorbedShortfallInr,
    paymentStatus,
    nextAmountPaidInr,
    amountPaidInr
  };
}

function buildOosShippingSettlementMeta(order, priced) {
  const paid = roundMoney2(Number(order?.amountPaidInr) || 0);
  const maxBalanceDueInr = roundMoney2(Number(order?.balanceDueInr) || 0);
  return {
    pending: true,
    policyVersion: 3,
    heldDeliveryCharges: roundMoney2(Number(priced.oldDelivery) || 0),
    provisionalQuotedDelivery: roundMoney2(Number(priced.quotedDelivery) || 0),
    provisionalQuotedMock: Boolean(priced.shipMeta?.mock),
    provisionalCourierName: priced.shippingSnapshot?.courierName || null,
    itemsSubtotal: roundMoney2(Number(priced.subtotal) || 0),
    tax: roundMoney2(Number(priced.tax) || 0),
    discount: roundMoney2(Number(priced.discount) || 0),
    amountPaidAtEdit: paid,
    maxBalanceDueInr,
    createdAt: new Date().toISOString()
  };
}

/**
 * Resolve live courier freight for an assigned courier id (Ship Now).
 */
async function resolveActualFreightForCourier(order, courierId) {
  const cid = Number(courierId);
  if (!Number.isFinite(cid)) {
    return { ok: false, freightInr: null, mock: false, message: 'courierId required' };
  }

  if (!ShiprocketService.enabled) {
    return {
      ok: false,
      freightInr: null,
      mock: true,
      message: 'Shiprocket disabled — cannot settle on mock freight'
    };
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
    if (listRes.mock) {
      return { ok: false, freightInr: null, mock: true, message: 'mock courier list' };
    }

    const match =
      listRes.couriers.find((c) => {
        const id = Number(c?.courier_company_id ?? c?.id ?? c?.courier_id);
        return Number.isFinite(id) && id === cid;
      }) || null;

    const courierRow = match || pickCheapestActiveCourier(listRes.couriers || [], {
      codRequired: parts.useCodAtDoor
    })?.courier;

    if (!courierRow) {
      return {
        ok: false,
        freightInr: null,
        mock: false,
        message: 'Courier not found in serviceability list'
      };
    }

    const split = ShiprocketService.extractShippingChargeSplit(
      courierRow,
      Number(courierRow.rate ?? courierRow.freight_charge) || 0
    );
    const freightInr = pickPositiveFreightInr(split.deliveryCharges, split.freightInr);
    if (freightInr == null) {
      return {
        ok: false,
        freightInr: null,
        mock: false,
        message: 'Courier rate missing or zero'
      };
    }

    return {
      ok: true,
      freightInr,
      mock: false,
      message: match ? 'matched_courier' : 'used_cheapest_fallback'
    };
  } catch (err) {
    logger.error('[oosShippingSettlement] resolveActualFreightForCourier failed', {
      orderId: order?.orderId,
      message: err?.message || String(err),
      stack: err?.stack
    });
    return { ok: false, freightInr: null, mock: false, message: err?.message || String(err) };
  }
}

/**
 * Pick settlement freight: actual (>0) preferred, else held (>0).
 * Zero only when held checkout shipping was 0 (free ship) and caller allows it (AWB present).
 * Never invent 0 from a missing/failed rate when held ship was positive.
 */
function resolveSettlementFreightInr({
  actualFreightInr,
  heldDeliveryCharges,
  assignRaw,
  allowZeroHeld = false
}) {
  let fromRaw = null;
  if (assignRaw && typeof assignRaw === 'object') {
    const nested =
      assignRaw.response?.data && typeof assignRaw.response.data === 'object'
        ? assignRaw.response.data
        : {};
    fromRaw = pickPositiveFreightInr(
      assignRaw.rate,
      assignRaw.freight_charge,
      nested.rate,
      nested.freight_charge
    );
  }

  const actual = pickPositiveFreightInr(actualFreightInr, fromRaw);
  if (actual != null) {
    return { freightInr: actual, source: 'actual', allowZeroFreight: false };
  }
  const heldPositive = pickPositiveFreightInr(heldDeliveryCharges);
  if (heldPositive != null) {
    return { freightInr: heldPositive, source: 'held_fallback', allowZeroFreight: false };
  }
  const heldNum = roundMoney2(Number(heldDeliveryCharges) || 0);
  if (allowZeroHeld && heldNum < MIN_POSITIVE_FREIGHT_INR) {
    return { freightInr: 0, source: 'held_zero_free_shipping', allowZeroFreight: true };
  }
  return { freightInr: null, source: 'none', allowZeroFreight: false };
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
      warning: 'Settlement refund due but Razorpay is not configured or payment id is missing.'
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
        reason: reason || 'oos_settled_after_ship_now'
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
        reason: reason || 'oos_settled_after_ship_now',
        createdAt: new Date()
      });
    }
    order.markModified('refundHistory');
    return { refundAttempted: true, refund, warning: null };
  } catch (err) {
    // Idempotent-ish: if Razorpay says already refunded / amount exceeds, surface clearly.
    logger.error('[oosShippingSettlement] refund failed', {
      orderId: order?.orderId,
      refundInr,
      message: err?.message || String(err),
      razorpay: err?.error || null
    });
    return {
      refundAttempted: true,
      refund: null,
      warning: err?.error?.description || err?.message || 'Refund API failed'
    };
  }
}

/**
 * Persist critical money fields; never leave Razorpay ahead of DB if we can help it.
 */
async function persistOrderMoneyState(order, context) {
  try {
    await order.save();
    return { ok: true, via: 'save' };
  } catch (saveErr) {
    logger.error('[oosShippingSettlement] order.save failed — trying updateOne fallback', {
      orderId: order?.orderId,
      context,
      message: saveErr?.message || String(saveErr)
    });
    try {
      const setDoc = {
        amountPaidInr: order.amountPaidInr,
        totalAmount: order.totalAmount,
        deliveryCharges: order.deliveryCharges,
        balanceDueInr: order.balanceDueInr,
        paymentStatus: order.paymentStatus,
        refundHistory: order.refundHistory,
        'paymentInfo.oosShippingSettlement': order.paymentInfo?.oosShippingSettlement,
        'paymentInfo.fullOrderAmountPaise': order.paymentInfo?.fullOrderAmountPaise,
        updatedAt: new Date()
      };
      if (order.returnInfo) setDoc.returnInfo = order.returnInfo;
      const r = await Order.updateOne({ _id: order._id }, { $set: setDoc });
      if (r.matchedCount !== 1) {
        throw new Error(`updateOne matched ${r.matchedCount}`);
      }
      return { ok: true, via: 'updateOne' };
    } catch (upErr) {
      logger.error('[oosShippingSettlement] CRITICAL: money persist failed after possible Razorpay refund', {
        orderId: order?.orderId,
        context,
        message: upErr?.message || String(upErr),
        razorpayPaymentId: order?.paymentInfo?.razorpayPaymentId || null
      });
      return { ok: false, via: null, message: upErr?.message || String(upErr) };
    }
  }
}

/**
 * After AWB: bill with positive freight (actual preferred, held fallback); refund excess; never raise due.
 */
async function settleOosShippingAfterActualFreight(order, opts = {}) {
  try {
    if (!order) {
      return { settled: false, skipped: true, reason: 'no_order' };
    }

    const meta = order.paymentInfo?.oosShippingSettlement;
    if (!meta || meta.pending !== true) {
      return { settled: false, skipped: true, reason: 'not_pending' };
    }

    const held = roundMoney2(
      Number(meta.heldDeliveryCharges != null ? meta.heldDeliveryCharges : order.deliveryCharges) || 0
    );
    const hasAwb = Boolean(
      String(order.shipmentInfo?.awbCode || order.shipmentInfo?.trackingNumber || '').trim()
    );

    // Mock courier list with no held ship → cannot settle safely.
    if (
      opts.mock === true &&
      pickPositiveFreightInr(held) == null &&
      !(held < MIN_POSITIVE_FREIGHT_INR && hasAwb)
    ) {
      return { settled: false, skipped: true, reason: 'mock_freight' };
    }

    const freightPick = resolveSettlementFreightInr({
      actualFreightInr: opts.actualFreightInr,
      heldDeliveryCharges: held,
      assignRaw: opts.assignRaw || null,
      allowZeroHeld: hasAwb
    });

    if (freightPick.freightInr == null) {
      logger.warn('[oosShippingSettlement] skip settle — no usable freight', {
        orderId: order.orderId,
        actualFreightInr: opts.actualFreightInr,
        held,
        hasAwb
      });
      return { settled: false, skipped: true, reason: 'no_positive_freight' };
    }

    const freightInr = freightPick.freightInr;

    const livePaid = roundMoney2(Number(order.amountPaidInr) || 0);
    const metaPaid = roundMoney2(Number(meta.amountPaidAtEdit) || 0);
    const amountPaidInr = livePaid > 0.01 ? livePaid : metaPaid;

    const maxBalanceDueInr = roundMoney2(
      Math.max(0, Number(meta.maxBalanceDueInr != null ? meta.maxBalanceDueInr : order.balanceDueInr) || 0)
    );

    const math = computeFinalOosSettlement({
      subtotal: order.subtotal,
      tax: order.tax,
      discount: order.discount,
      actualFreightInr: freightInr,
      amountPaidInr,
      maxBalanceDueInr,
      allowZeroFreight: Boolean(freightPick.allowZeroFreight)
    });

    if (!math.ok) {
      return { settled: false, skipped: true, reason: math.reason || 'math_rejected' };
    }

    const beforeDelivery = roundMoney2(Number(order.deliveryCharges) || 0);
    const beforeTotal = roundMoney2(Number(order.totalAmount) || 0);
    const beforeDue = roundMoney2(Number(order.balanceDueInr) || 0);
    const beforePaid = roundMoney2(Number(order.amountPaidInr) || 0);

    let refundWarning = null;
    let refundId = null;

    // If a refund is required, take money on Razorpay BEFORE mutating order totals.
    if (math.refundInr > 0.005) {
      const priorOosRefund = (order.refundHistory || []).find(
        (r) =>
          String(r?.reason || '') === 'oos_settled_after_ship_now' &&
          Number(r?.amountInr) > 0.005
      );
      if (priorOosRefund) {
        refundId = priorOosRefund.refundId || null;
        logger.warn('[oosShippingSettlement] skipping Razorpay — oos refund already in refundHistory', {
          orderId: order.orderId,
          refundId,
          amountInr: priorOosRefund.amountInr
        });
      } else {
        const refundOutcome = await attemptSettlementRefund(
          order,
          math.refundInr,
          'oos_settled_after_ship_now'
        );
        refundWarning = refundOutcome.warning;
        if (!refundOutcome.refund || refundOutcome.warning) {
          logger.error('[oosShippingSettlement] refund failed — order left unchanged for retry', {
            orderId: order.orderId,
            refundInr: math.refundInr,
            warning: refundWarning,
            freightInr,
            freightSource: freightPick.source
          });
          return {
            settled: false,
            skipped: false,
            reason: 'refund_failed',
            refundWarning,
            refundInr: math.refundInr,
            actualFreightInr: freightInr,
            freightSource: freightPick.source
          };
        }
        refundId = refundOutcome.refund.id || null;
        const earlyPersist = await persistOrderMoneyState(order, 'refund_history_only');
        if (!earlyPersist.ok) {
          logger.error('[oosShippingSettlement] CRITICAL: Razorpay refunded but refundHistory persist failed', {
            orderId: order.orderId,
            refundId,
            refundInr: math.refundInr
          });
        }
      }
    }

    order.deliveryCharges = math.customerDelivery;
    order.totalAmount = math.newTotal;
    order.balanceDueInr = math.refundInr > 0.005 ? 0 : math.balanceDueInr;
    order.paymentInfo = order.paymentInfo || {};
    order.paymentInfo.fullOrderAmountPaise = Math.round(math.newTotal * 100);

    if (math.refundInr > 0.005) {
      order.amountPaidInr = math.newTotal;
      order.paymentStatus = 'paid';
      order.returnInfo = mergeReturnInfo(order.returnInfo, {
        refundContext: 'cancellation',
        status: 'partially_refunded',
        refundAmount: sumRefundHistoryInr(order),
        refundId
      });
      order.markModified('returnInfo');
    } else {
      order.amountPaidInr = math.nextAmountPaidInr;
      order.balanceDueInr = math.balanceDueInr;
      order.paymentStatus = math.paymentStatus;
    }

    order.paymentInfo.oosShippingSettlement = {
      ...meta,
      pending: false,
      settledAt: new Date().toISOString(),
      actualFreightInr: freightInr,
      freightSource: freightPick.source,
      customerDelivery: math.customerDelivery,
      heldDeliveryCharges: held,
      usedActualFreight: freightPick.source === 'actual',
      policyVersion: 3,
      courierId: opts.courierId != null ? Number(opts.courierId) : null,
      courierName: opts.courierName || null,
      source: opts.source || 'ship_now',
      refundInr: math.refundInr,
      refundId: refundId || null,
      refundStatus: math.refundInr > 0.005 ? 'ok' : 'not_required',
      idealDue: math.idealDue,
      balanceDueInr: roundMoney2(Number(order.balanceDueInr) || 0),
      absorbedShortfallInr: math.absorbedShortfallInr,
      maxBalanceDueInr
    };
    order.markModified('paymentInfo');

    if (order.shippingSnapshot && typeof order.shippingSnapshot === 'object') {
      if (opts.courierName) order.shippingSnapshot.courierName = opts.courierName;
      if (opts.courierId != null && Number.isFinite(Number(opts.courierId))) {
        order.shippingSnapshot.courierCompanyId = Number(opts.courierId);
      }
      order.markModified('shippingSnapshot');
    }

    order.adminEditHistory = order.adminEditHistory || [];
    order.adminEditHistory.push({
      action: 'oos_settled_after_ship_now',
      note: `OOS settled freight=${freightInr} source=${freightPick.source} (no customer due increase)`,
      performedBy: null,
      createdAt: new Date(),
      before: {
        deliveryCharges: beforeDelivery,
        totalAmount: beforeTotal,
        amountPaidInr: beforePaid,
        balanceDueInr: beforeDue
      },
      after: {
        deliveryCharges: math.customerDelivery,
        totalAmount: math.newTotal,
        amountPaidInr: roundMoney2(Number(order.amountPaidInr) || 0),
        balanceDueInr: roundMoney2(Number(order.balanceDueInr) || 0)
      },
      metadata: {
        heldDeliveryCharges: held,
        freightInr,
        freightSource: freightPick.source,
        customerDelivery: math.customerDelivery,
        refundInr: math.refundInr,
        refundWarning,
        refundId,
        idealDue: math.idealDue,
        maxBalanceDueInr,
        absorbedShortfallInr: math.absorbedShortfallInr,
        courierId: opts.courierId ?? null,
        courierName: opts.courierName || null
      }
    });
    order.markModified('adminEditHistory');

    // Persist MONEY first — never let customerFacingNotes / other soft fields block settlement.
    const persistFinal = await persistOrderMoneyState(order, 'final_settle');
    if (!persistFinal.ok) {
      return {
        settled: true,
        skipped: false,
        refundInr: math.refundInr,
        refundId,
        refundWarning: persistFinal.message,
        customerDelivery: math.customerDelivery,
        actualFreightInr: freightInr,
        freightSource: freightPick.source,
        newTotal: math.newTotal,
        persistWarning: persistFinal.message,
        critical: Boolean(refundId)
      };
    }

    const noteMsg =
      math.refundInr > 0.005
        ? `Your order was updated after courier assignment. A refund of ₹${math.refundInr.toFixed(2)} has been processed.`
        : math.balanceDueInr > 0.005
          ? `Your order was updated after courier assignment. Balance due is now ₹${math.balanceDueInr.toFixed(2)}.`
          : `Your order was updated after courier assignment. Final shipping is ₹${math.customerDelivery.toFixed(2)}.`;

    try {
      const noteOrder = await Order.findById(order._id);
      if (noteOrder) {
        noteOrder.customerFacingNotes = noteOrder.customerFacingNotes || [];
        noteOrder.customerFacingNotes.push({
          message: noteMsg,
          kind: 'oos_shipping_settled',
          createdAt: new Date(),
          metadata: {
            freightInr,
            freightSource: freightPick.source,
            customerDelivery: math.customerDelivery,
            refundInr: math.refundInr,
            balanceDueInr: math.balanceDueInr,
            absorbedShortfallInr: math.absorbedShortfallInr
          }
        });
        noteOrder.markModified('customerFacingNotes');
        await noteOrder.save();
      }
    } catch (noteErr) {
      logger.warn('[oosShippingSettlement] customer note save failed after money settled', {
        orderId: order.orderId,
        message: noteErr?.message || String(noteErr)
      });
    }

    logger.info('[oosShippingSettlement] settled', {
      orderId: order.orderId,
      held,
      freightInr,
      freightSource: freightPick.source,
      newTotal: math.newTotal,
      refundInr: math.refundInr,
      balanceDueInr: order.balanceDueInr
    });

    return {
      settled: true,
      skipped: false,
      refundInr: math.refundInr,
      refundWarning,
      refundId,
      customerDelivery: math.customerDelivery,
      actualFreightInr: freightInr,
      freightSource: freightPick.source,
      newTotal: math.newTotal,
      balanceDueInr: roundMoney2(Number(order.balanceDueInr) || 0),
      absorbedShortfallInr: math.absorbedShortfallInr
    };
  } catch (err) {
    logger.error('[oosShippingSettlement] settleOosShippingAfterActualFreight threw', {
      orderId: order?.orderId,
      message: err?.message || String(err),
      stack: err?.stack
    });
    return {
      settled: false,
      skipped: false,
      reason: 'settlement_exception',
      message: err?.message || String(err)
    };
  }
}

/**
 * Safe retry when AWB exists and settlement still pending (sync / pickup / ship now).
 */
async function trySettlePendingOosOrder(order, opts = {}) {
  try {
    if (!order?.paymentInfo?.oosShippingSettlement?.pending) {
      return { settled: false, skipped: true, reason: 'not_pending' };
    }
    const awb = String(order.shipmentInfo?.awbCode || order.shipmentInfo?.trackingNumber || '').trim();
    if (!awb) {
      return { settled: false, skipped: true, reason: 'no_awb_yet' };
    }

    const courierId =
      opts.courierId != null
        ? Number(opts.courierId)
        : Number(order.shipmentInfo?.assignedCourierId || order.shippingSnapshot?.courierCompanyId);

    let actualFreightInr = opts.actualFreightInr != null ? opts.actualFreightInr : null;
    let freightMock = false;
    if (actualFreightInr == null && Number.isFinite(courierId)) {
      const freightRes = await resolveActualFreightForCourier(order, courierId);
      freightMock = Boolean(freightRes.mock);
      if (freightRes.ok) actualFreightInr = freightRes.freightInr;
    }

    return settleOosShippingAfterActualFreight(order, {
      actualFreightInr,
      mock: freightMock && pickPositiveFreightInr(order.paymentInfo?.oosShippingSettlement?.heldDeliveryCharges) == null,
      courierId: Number.isFinite(courierId) ? courierId : null,
      courierName: opts.courierName || order.shipmentInfo?.courier || order.shippingSnapshot?.courierName || null,
      assignRaw: opts.assignRaw || null,
      source: opts.source || 'oos_settle_retry'
    });
  } catch (err) {
    logger.error('[oosShippingSettlement] trySettlePendingOosOrder threw', {
      orderId: order?.orderId,
      message: err?.message || String(err)
    });
    return { settled: false, skipped: false, reason: 'retry_exception', message: err?.message || String(err) };
  }
}

module.exports = {
  MIN_POSITIVE_FREIGHT_INR,
  shouldDeferShippingSettlement,
  buildOosShippingSettlementMeta,
  computeDeferredApplyFinancials,
  computeFinalOosSettlement,
  pickPositiveFreightInr,
  resolveSettlementFreightInr,
  resolveActualFreightForCourier,
  settleOosShippingAfterActualFreight,
  trySettlePendingOosOrder,
  isOnlineCapturedMethod,
  sumRefundHistoryInr
};
