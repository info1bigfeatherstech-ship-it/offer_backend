'use strict';

/**
 * Dropshipper serviceability — quote warehouse → customer with explicit package dims.
 * Reuses active shipping provider; does not alter ecomm/wholesale delivery controllers.
 */

const {
  checkDeliveryAvailabilityForActiveProvider
} = require('../../services/shippingQuote.service');

const PIN_RE = /^\d{6}$/;

function normalizePincode(value) {
  return String(value || '')
    .replace(/\D/g, '')
    .slice(0, 6);
}

function assertPincode(value, fieldName) {
  const pin = normalizePincode(value);
  if (!PIN_RE.test(pin)) {
    const err = new Error(`${fieldName} must be a valid 6-digit pincode`);
    err.statusCode = 400;
    err.code = 'INVALID_PINCODE';
    throw err;
  }
  return pin;
}

function parsePositiveNumber(value, fieldName, { min = 0.01, allowZero = false } = {}) {
  if (value === undefined || value === null || value === '') {
    const err = new Error(`${fieldName} is required`);
    err.statusCode = 400;
    err.code = 'VALIDATION_ERROR';
    throw err;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || (allowZero ? n < 0 : n < min)) {
    const err = new Error(
      `${fieldName} must be a ${allowZero ? 'non-negative' : 'positive'} number`
    );
    err.statusCode = 400;
    err.code = 'VALIDATION_ERROR';
    throw err;
  }
  return n;
}

function parseOptionalAmount(value, fieldName) {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    const err = new Error(`${fieldName} must be a non-negative number`);
    err.statusCode = 400;
    err.code = 'VALIDATION_ERROR';
    throw err;
  }
  return n;
}

function normalizePaymentMode(value) {
  const mode = String(value || 'both')
    .trim()
    .toLowerCase();
  if (mode === 'cod' || mode === 'prepaid' || mode === 'both') return mode;
  const err = new Error('paymentMode must be one of: prepaid, cod, both');
  err.statusCode = 400;
  err.code = 'VALIDATION_ERROR';
  throw err;
}

function mapQuoteResult(result) {
  return {
    isDeliverable: result?.isDeliverable === true,
    deliveryCharges: Math.max(0, Number(result?.deliveryCharges) || 0),
    freightInr:
      result?.freightInr != null
        ? Math.max(0, Number(result.freightInr) || 0)
        : Math.max(0, Number(result?.deliveryCharges) || 0),
    codFeeInr: Math.max(0, Number(result?.codFeeInr) || 0),
    estimatedDays: result?.estimatedDays != null ? String(result.estimatedDays) : null,
    courierName: result?.courierName || null,
    courierCompanyId: result?.courierCompanyId || null,
    codAvailable: result?.codAvailable === true,
    message: result?.message || null,
    code: result?.code || null,
    mock: result?.mock === true,
    shippingProvider: result?.shippingProvider || result?.provider || null
  };
}

/**
 * @param {object} input
 * @param {string} input.customerPincode
 * @param {string} input.warehousePincode
 * @param {number} input.weightKg
 * @param {number} input.lengthCm
 * @param {number} input.widthCm  — breadth
 * @param {number} input.heightCm
 * @param {'prepaid'|'cod'|'both'} [input.paymentMode]
 * @param {number} [input.orderAmount] — used for COD declared value
 * @param {'ecomm'|'wholesale'} [input.storefront] — which provider settings to use
 */
async function checkServiceability(input = {}) {
  const customerPincode = assertPincode(
    input.customerPincode ?? input.deliveryPincode ?? input.pincode,
    'customerPincode'
  );
  const warehousePincode = assertPincode(
    input.warehousePincode ?? input.pickupPincode,
    'warehousePincode'
  );

  const weightKg = parsePositiveNumber(
    input.weightKg ?? input.weight,
    'weightKg',
    { min: 0.05 }
  );
  const lengthCm = parsePositiveNumber(
    input.lengthCm ?? input.length ?? input.l,
    'lengthCm',
    { min: 1 }
  );
  const widthCm = parsePositiveNumber(
    input.widthCm ?? input.breadthCm ?? input.breadth ?? input.width ?? input.b,
    'widthCm',
    { min: 1 }
  );
  const heightCm = parsePositiveNumber(
    input.heightCm ?? input.height ?? input.h,
    'heightCm',
    { min: 1 }
  );

  const paymentMode = normalizePaymentMode(input.paymentMode);
  const orderAmount = parseOptionalAmount(
    input.orderAmount ?? input.codAmount,
    'orderAmount'
  );

  // Provider settings still keyed by ecomm|wholesale; dropship reuses active provider.
  const storefront = input.storefront === 'wholesale' ? 'wholesale' : 'ecomm';

  const baseOpts = {
    weightKg,
    lengthCm,
    widthCm,
    heightCm,
    pickupPincode: warehousePincode,
    storefront
  };

  const quotes = {
    prepaid: null,
    cod: null
  };

  if (paymentMode === 'prepaid' || paymentMode === 'both') {
    const prepaidRaw = await checkDeliveryAvailabilityForActiveProvider(customerPincode, {
      ...baseOpts,
      codAmount: 0,
      orderAmount: orderAmount || 0
    });
    quotes.prepaid = mapQuoteResult(prepaidRaw);
  }

  if (paymentMode === 'cod' || paymentMode === 'both') {
    // COD quotes need a declared amount; if caller omitted it, use a minimal placeholder
    // so provider returns COD rates (FE should pass real orderAmount when known).
    const codDeclared = orderAmount > 0 ? orderAmount : 1;
    const codRaw = await checkDeliveryAvailabilityForActiveProvider(customerPincode, {
      ...baseOpts,
      codAmount: codDeclared,
      orderAmount: codDeclared
    });
    quotes.cod = mapQuoteResult(codRaw);
  }

  const primary =
    paymentMode === 'cod'
      ? quotes.cod
      : paymentMode === 'prepaid'
        ? quotes.prepaid
        : quotes.prepaid?.isDeliverable
          ? quotes.prepaid
          : quotes.cod;

  return {
    customerPincode,
    warehousePincode,
    package: {
      weightKg,
      lengthCm,
      widthCm,
      heightCm
    },
    paymentMode,
    orderAmount: orderAmount > 0 ? orderAmount : null,
    storefront,
    isDeliverable: primary?.isDeliverable === true,
    estimatedDays: primary?.estimatedDays ?? null,
    deliveryCharges: primary?.deliveryCharges ?? 0,
    shippingProvider: primary?.shippingProvider || null,
    quotes
  };
}

module.exports = {
  checkServiceability,
  normalizePincode,
  mapQuoteResult
};
