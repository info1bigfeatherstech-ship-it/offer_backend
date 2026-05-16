/**
 * Carrier fulfilment (Shiprocket push / AWB / pickup / label) must align with how the order is paid.
 *
 * Rules (keep in sync with product expectations):
 * - COD: may ship before online capture (cash at delivery).
 * - Online, full settlement: require paymentStatus === "paid" (pending/initiated block).
 * - Online, advance with remaining balance via COD: allow once the first Razorpay instalment
 *   meets the same minimum as at order creation (advance % of total, capped like checkout).
 * - Online, advance with remaining balance online: treat like full — must be fully paid.
 *
 * @typedef {{ ok: true, reason: string }} FulfillmentPaymentOk
 * @typedef {{ ok: false, code: string, message: string, details?: object }} FulfillmentPaymentBlocked
 */

const { roundMoney2 } = require('../services/checkoutComputation.service');

/**
 * Mirrors order.controller advance first-charge calculation for splitMode "advance".
 * @param {number} totalAmount
 * @param {number} advancePercent
 * @returns {number|null}
 */
function computeLockedAdvanceFirstChargeInr(totalAmount, advancePercent) {
  const totalInr = roundMoney2(Number(totalAmount) || 0);
  const pct = Number(advancePercent);
  if (!(totalInr > 0) || !Number.isFinite(pct) || pct <= 0) return null;
  const advInrRaw = roundMoney2((totalInr * pct) / 100);
  const advInr = Math.max(1, Math.min(roundMoney2(totalInr - 0.01), advInrRaw));
  return advInr;
}

/**
 * @param {import('mongoose').Document|object} order
 * @returns {FulfillmentPaymentOk|FulfillmentPaymentBlocked}
 */
function evaluateOrderPaymentForShiprocketFulfillment(order) {
  if (!order) {
    return { ok: false, code: 'ORDER_REQUIRED', message: 'Order is required.' };
  }

  const paymentMethod = String(order.paymentInfo?.method || '').toLowerCase();
  if (paymentMethod === 'cod') {
    return { ok: true, reason: 'cod' };
  }

  if (paymentMethod !== 'online' && paymentMethod !== 'prepaid') {
    return {
      ok: false,
      code: 'UNSUPPORTED_PAYMENT_METHOD',
      message: 'Only COD or online orders can use carrier fulfilment.',
      details: { paymentMethod: order.paymentInfo?.method || null }
    };
  }

  const status = String(order.paymentStatus || '').toLowerCase();
  if (['failed', 'refunded', 'partially_refunded'].includes(status)) {
    return {
      ok: false,
      code: 'PAYMENT_NOT_SUCCESSFUL',
      message: 'Payment is not in a state that allows shipping.',
      details: { paymentStatus: status }
    };
  }

  if (status === 'paid') {
    return { ok: true, reason: 'paid_in_full' };
  }

  const splitMode = String(order.paymentInfo?.splitMode || 'full').toLowerCase();
  const balanceCod =
    String(order.paymentInfo?.balanceCollectionMethod || 'online').toLowerCase() === 'cod';

  const isAdvanceSplit = splitMode === 'advance';
  const advancePctRaw = order.paymentInfo?.advancePercent;
  const advancePct =
    advancePctRaw != null && Number.isFinite(Number(advancePctRaw)) ? Number(advancePctRaw) : null;

  if (isAdvanceSplit && balanceCod && status === 'partially_paid') {
    const minFirst =
      advancePct != null ? computeLockedAdvanceFirstChargeInr(order.totalAmount, advancePct) : null;
    const paid = roundMoney2(Number(order.amountPaidInr) || 0);

    if (minFirst != null && paid + 0.005 >= minFirst) {
      return { ok: true, reason: 'advance_captured_cod_balance_pending' };
    }

    if (minFirst == null && paid > 0.01) {
      return { ok: true, reason: 'advance_captured_legacy' };
    }

    return {
      ok: false,
      code: 'ADVANCE_OR_FULL_PAYMENT_REQUIRED',
      message:
        minFirst != null
          ? `Waiting for the customer to pay the agreed online instalment (at least ₹${minFirst}) before Shiprocket actions.`
          : 'Waiting for the customer to complete the required online payment before Shiprocket actions.',
      details: {
        paymentStatus: status,
        amountPaidInr: paid,
        minimumAdvanceInr: minFirst
      }
    };
  }

  return {
    ok: false,
    code: 'PAYMENT_REQUIRED',
    message:
      'Waiting for the customer to complete online payment before Shiprocket actions.',
    details: {
      paymentStatus: status,
      splitMode,
      balanceCollectionMethod: order.paymentInfo?.balanceCollectionMethod || 'online'
    }
  };
}

/** HTTP status for admin API when fulfilment is blocked for payment reasons */
function fulfillmentPaymentBlockHttpStatus(code) {
  const c = String(code || '');
  if (
    c === 'PAYMENT_REQUIRED' ||
    c === 'ADVANCE_OR_FULL_PAYMENT_REQUIRED' ||
    c === 'UNSUPPORTED_PAYMENT_METHOD' ||
    c === 'PAYMENT_NOT_SUCCESSFUL' ||
    c === 'ORDER_REQUIRED' ||
    c === 'SHIPMENT_PAYMENT_BLOCKED'
  ) {
    return 403;
  }
  return 502;
}

module.exports = {
  evaluateOrderPaymentForShiprocketFulfillment,
  computeLockedAdvanceFirstChargeInr,
  fulfillmentPaymentBlockHttpStatus
};
