const STALE_QUOTE_HTTP_STATUS = 409;

const normalizePaymentMethod = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'cod') return 'cod';
  if (normalized === 'online' || normalized === 'prepaid') return 'online';
  return null;
};

const normalizePaymentPlan = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'partial' || normalized === 'advance' || normalized === 'half' || normalized === 'seventy') return 'advance';
  return 'full';
};

const ALLOWED_ADVANCE_PAYMENT_PERCENTS = Object.freeze([25, 50, 75]);

const inferAdvancePercentFromPlanAlias = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'half') return 50;
  if (normalized === 'seventy') return 75;
  return null;
};

const normalizeAdvancePaymentPercent = (value, { allowNull = true } = {}) => {
  if (value === null || value === undefined || value === '') {
    return allowNull ? null : ALLOWED_ADVANCE_PAYMENT_PERCENTS[0];
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const rounded = Math.round(numeric);
  if (!ALLOWED_ADVANCE_PAYMENT_PERCENTS.includes(rounded)) return null;
  return rounded;
};

const resolveDefaultAdvancePercent = () => {
  const fromEnv = normalizeAdvancePaymentPercent(process.env.CHECKOUT_ADVANCE_PERCENT);
  return fromEnv || 25;
};

const resolveAdvancePaymentSelection = ({
  paymentPlan,
  paymentAdvancePercent
} = {}) => {
  const normalizedPaymentPlan = normalizePaymentPlan(paymentPlan);
  const hasAdvancePercentInput =
    paymentAdvancePercent !== undefined &&
    paymentAdvancePercent !== null &&
    String(paymentAdvancePercent).trim() !== '';
  const normalizedAdvancePercentInput = normalizeAdvancePaymentPercent(paymentAdvancePercent);

  return {
    normalizedPaymentPlan,
    hasAdvancePercentInput,
    normalizedAdvancePercentInput,
    effectiveAdvancePercent: normalizedPaymentPlan === 'advance'
      ? (
          normalizedAdvancePercentInput ??
          inferAdvancePercentFromPlanAlias(paymentPlan) ??
          resolveDefaultAdvancePercent()
        )
      : null
  };
};

const normalizeIdempotencyKey = (value) => {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  if (normalized.length > 128) return null;
  return normalized;
};

const createCheckoutFlowError = ({
  statusCode = 400,
  code,
  message,
  details
}) => {
  const error = new Error(message || 'Checkout flow error');
  error.statusCode = statusCode;
  error.code = code;
  if (details !== undefined) {
    error.details = details;
  }
  return error;
};

const createInvalidPaymentMethodError = () =>
  createCheckoutFlowError({
    statusCode: 400,
    code: 'INVALID_PAYMENT_METHOD',
    message: 'paymentMethod must be cod or prepaid/online'
  });

const createQuoteExpiredError = () =>
  createCheckoutFlowError({
    statusCode: STALE_QUOTE_HTTP_STATUS,
    code: 'QUOTE_EXPIRED',
    message: 'Quote expired. Please refresh checkout totals.',
    details: { reason: 'quote_expired' }
  });

const createQuoteStaleError = (reason, overrides = {}) =>
  createCheckoutFlowError({
    statusCode: STALE_QUOTE_HTTP_STATUS,
    code: 'QUOTE_STALE',
    message: overrides.message || 'Quote is stale. Please refresh checkout totals.',
    details: {
      reason,
      ...(overrides.details || {})
    }
  });

const sendCheckoutFlowError = (res, error, fallbackMessage, fallbackCode = null) => {
  const statusCode = error?.statusCode || 500;
  const payload = {
    success: false,
    message: error?.message || fallbackMessage || 'Request failed'
  };

  if (error?.code) {
    payload.code = error.code;
  } else if (fallbackCode) {
    payload.code = fallbackCode;
  }

  if (error?.details !== undefined) {
    payload.details = error.details;
  }

  return res.status(statusCode).json(payload);
};

const isOrderStaffRequest = (req) => {
  const role = String(req?.user?.role || req?.userRole || req?.userType || '').trim().toLowerCase();
  return role === 'admin' || role === 'order_manager';
};

const buildRequestLogContext = (req, extras = {}) => ({
  requestId: req?.id || null,
  userId: req?.userId || req?.user?.id || null,
  ...extras
});

module.exports = {
  STALE_QUOTE_HTTP_STATUS,
  normalizePaymentMethod,
  normalizePaymentPlan,
  ALLOWED_ADVANCE_PAYMENT_PERCENTS,
  normalizeAdvancePaymentPercent,
  inferAdvancePercentFromPlanAlias,
  resolveDefaultAdvancePercent,
  resolveAdvancePaymentSelection,
  normalizeIdempotencyKey,
  createCheckoutFlowError,
  createInvalidPaymentMethodError,
  createQuoteExpiredError,
  createQuoteStaleError,
  sendCheckoutFlowError,
  isOrderStaffRequest,
  buildRequestLogContext
};
