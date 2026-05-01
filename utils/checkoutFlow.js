const STALE_QUOTE_HTTP_STATUS = 409;

const normalizePaymentMethod = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'cod') return 'cod';
  if (normalized === 'online' || normalized === 'prepaid') return 'online';
  return null;
};

const normalizePaymentPlan = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'partial' || normalized === 'advance') return 'advance';
  return 'full';
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
  normalizeIdempotencyKey,
  createCheckoutFlowError,
  createInvalidPaymentMethodError,
  createQuoteExpiredError,
  createQuoteStaleError,
  sendCheckoutFlowError,
  isOrderStaffRequest,
  buildRequestLogContext
};
