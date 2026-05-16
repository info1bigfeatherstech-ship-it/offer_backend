/**
 * Store-level checkout payment rules (admin toggles).
 *
 * Full COD and partial pay (advance online + balance COD/online) are independent:
 * - codEnabled → pay entire order as COD at delivery
 * - partialPaymentEnabled → pay advance online; balance online or COD at delivery
 *
 * Carrier / pincode COD (Shiprocket) is validated separately via shippingMeta.codAvailable.
 */

const {
  normalizePaymentMethod,
  normalizePaymentPlan,
  normalizeBalanceCollection,
  createCheckoutFlowError
} = require('./checkoutFlow');

function isFullCodCheckout(paymentMethod) {
  return normalizePaymentMethod(paymentMethod) === 'cod';
}

function isAdvanceBalanceCodCheckout({ paymentMethod, paymentPlan, balanceCollection }) {
  return (
    normalizePaymentMethod(paymentMethod) === 'online' &&
    normalizePaymentPlan(paymentPlan) === 'advance' &&
    normalizeBalanceCollection(balanceCollection) === 'cod'
  );
}

/** Any flow where cash is collected at delivery (full or partial balance). */
function requiresCarrierCodAtDelivery({ paymentMethod, paymentPlan, balanceCollection }) {
  return (
    isFullCodCheckout(paymentMethod) ||
    isAdvanceBalanceCodCheckout({ paymentMethod, paymentPlan, balanceCollection })
  );
}

/**
 * Admin policy only (not Shiprocket). Throws checkoutFlowError on violation.
 */
function assertStorePolicyAllowsCheckout({ policy, paymentMethod, paymentPlan, balanceCollection }) {
  const method = normalizePaymentMethod(paymentMethod);
  const plan = normalizePaymentPlan(paymentPlan);
  const balance = normalizeBalanceCollection(balanceCollection);

  if (isFullCodCheckout(method)) {
    if (!policy?.codEnabled) {
      throw createCheckoutFlowError({
        statusCode: 400,
        code: 'COD_DISABLED_BY_STORE',
        message: 'Cash on delivery is not available at the moment.'
      });
    }
    return;
  }

  if (plan === 'advance') {
    if (!policy?.partialPaymentEnabled) {
      throw createCheckoutFlowError({
        statusCode: 400,
        code: 'PARTIAL_PAYMENT_DISABLED',
        message: 'Partial payment is not available. Choose full payment or another method.'
      });
    }
    if (balance === 'cod' && isAdvanceBalanceCodCheckout({ paymentMethod: method, paymentPlan: plan, balanceCollection: balance })) {
      return;
    }
    if (balance === 'cod') {
      throw createCheckoutFlowError({
        statusCode: 400,
        code: 'INVALID_BALANCE_COLLECTION',
        message: 'Pay on delivery for the balance applies only when using partial pay now.'
      });
    }
  }
}

/**
 * @returns {{ ok: true } | { ok: false, statusCode: number, code: string, message: string }}
 */
function validateCarrierCodForCheckout({ carrierCodAvailable, paymentMethod, paymentPlan, balanceCollection }) {
  if (!requiresCarrierCodAtDelivery({ paymentMethod, paymentPlan, balanceCollection })) {
    return { ok: true };
  }
  if (carrierCodAvailable === false) {
    return {
      ok: false,
      statusCode: 400,
      code: 'COD_NOT_AVAILABLE',
      message: 'COD is not available for this pincode and cart combination.'
    };
  }
  return { ok: true };
}

/**
 * Client-facing COD flags (carrier + store policy).
 * @param {boolean|null|undefined} carrierCodAvailable — Shiprocket / quote shippingMeta
 */
function buildClientCodAvailability({ policy, carrierCodAvailable }) {
  const carrierOk = carrierCodAvailable !== false;
  return {
    /** Full-order COD at delivery (legacy field name). */
    codAvailable: carrierOk && Boolean(policy?.codEnabled),
    fullCodAvailable: carrierOk && Boolean(policy?.codEnabled),
    /** Partial pay with balance collected as COD at delivery. */
    partialBalanceCodAvailable: carrierOk && Boolean(policy?.partialPaymentEnabled)
  };
}

module.exports = {
  isFullCodCheckout,
  isAdvanceBalanceCodCheckout,
  requiresCarrierCodAtDelivery,
  assertStorePolicyAllowsCheckout,
  validateCarrierCodForCheckout,
  buildClientCodAvailability
};
