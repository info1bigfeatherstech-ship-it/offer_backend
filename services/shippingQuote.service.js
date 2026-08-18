/**
 * Routes checkout/delivery quotes to the ACTIVE shipping provider.
 * Fulfillment for existing orders must use resolveOrderShippingProvider(order), not this.
 */

const ShiprocketService = require('../utils/shiprocket');
const ShipmozoService = require('../utils/shipmozo');
const shippingProviderSettingsService = require('./shippingProviderSettings.service');
const { SHIPPING_PROVIDERS } = require('../constants/shippingProviders');
const logger = require('../utils/logger');

const CUSTOMER_DELIVERY_MESSAGES = Object.freeze({
  unavailable: 'Delivery not available at this time. Please try again later.',
  notServiceable: 'This pincode is currently not serviceable.'
});

function normalizeDeliveryMessage(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function isProviderInternalDeliveryFailure(result) {
  const msg = normalizeDeliveryMessage(result?.message);
  const code = normalizeDeliveryMessage(result?.code);
  if (!msg && !code) return false;
  return (
    /under verification|profile|kyc|not configured|warehouse|pickup pincode|pickup pin|api key|private key|public key/.test(
      msg
    ) ||
    /\bauth\b|unauthori[sz]ed|forbidden|credential|token/.test(msg) ||
    /not configured|misconfigured|verification|auth|credential/.test(code)
  );
}

function isCustomerPincodeNotServiceable(result) {
  const msg = normalizeDeliveryMessage(result?.message);
  const code = normalizeDeliveryMessage(result?.code);
  return (
    code === 'not serviceable' ||
    /\bnot serviceable\b/.test(msg) ||
    /\bnot deliverable\b/.test(msg) ||
    /no courier available for this route/.test(msg) ||
    /no active courier available for this route/.test(msg)
  );
}

function sanitizeCustomerFacingDeliveryResult(result, provider) {
  const base = {
    ...(result || {}),
    provider: result?.provider || provider || null,
    shippingProvider: result?.shippingProvider || provider || null
  };

  if (base.isDeliverable !== false) {
    return base;
  }

  const internalMessage = String(base.message || '').trim() || null;
  let customerMessage = CUSTOMER_DELIVERY_MESSAGES.unavailable;
  let customerCode = 'DELIVERY_TEMPORARILY_UNAVAILABLE';

  if (isProviderInternalDeliveryFailure(base)) {
    customerMessage = CUSTOMER_DELIVERY_MESSAGES.unavailable;
    customerCode = 'DELIVERY_PROVIDER_UNAVAILABLE';
  } else if (isCustomerPincodeNotServiceable(base)) {
    customerMessage = CUSTOMER_DELIVERY_MESSAGES.notServiceable;
    customerCode = 'PINCODE_NOT_SERVICEABLE';
  }

  return {
    ...base,
    message: customerMessage,
    customerMessage,
    internalMessage,
    code: customerCode
  };
}

/**
 * @param {string} deliveryPincode
 * @param {object} opts — weightKg, lengthCm, widthCm, heightCm, codAmount, orderAmount
 */
async function checkDeliveryAvailabilityForActiveProvider(deliveryPincode, opts = {}) {
  let provider = SHIPPING_PROVIDERS.SHIPROCKET;
  const storefront = opts.storefront === 'wholesale' ? 'wholesale' : 'ecomm';
  try {
    provider = await shippingProviderSettingsService.getActiveProviderForNewOrders(storefront);
  } catch (err) {
    logger.error('[shippingQuote] Failed to resolve active provider — using shiprocket', {
      message: err.message,
      storefront
    });
    provider = SHIPPING_PROVIDERS.SHIPROCKET;
  }

  if (provider === SHIPPING_PROVIDERS.SHIPMOZO) {
    const result = await ShipmozoService.checkDeliveryAvailability(deliveryPincode, {
      ...opts,
      storefront
    });
    return sanitizeCustomerFacingDeliveryResult({
      ...result,
      provider: SHIPPING_PROVIDERS.SHIPMOZO,
      shippingProvider: SHIPPING_PROVIDERS.SHIPMOZO
    }, SHIPPING_PROVIDERS.SHIPMOZO);
  }

  const result = await ShiprocketService.checkDeliveryAvailability(deliveryPincode, opts);
  return sanitizeCustomerFacingDeliveryResult({
    ...result,
    provider: SHIPPING_PROVIDERS.SHIPROCKET,
    shippingProvider: SHIPPING_PROVIDERS.SHIPROCKET
  }, SHIPPING_PROVIDERS.SHIPROCKET);
}

/**
 * @param {string} pincode
 * @param {number} weightKg
 * @param {object} dimensionOpts
 */
async function getDeliveryChargesForActiveProvider(pincode, weightKg = 1, dimensionOpts = {}) {
  const r = await checkDeliveryAvailabilityForActiveProvider(pincode, {
    weightKg,
    lengthCm: dimensionOpts.lengthCm,
    widthCm: dimensionOpts.widthCm,
    heightCm: dimensionOpts.heightCm,
    codAmount: dimensionOpts.codAmount,
    orderAmount: dimensionOpts.orderAmount,
    storefront: dimensionOpts.storefront
  });
  return {
    deliveryCharges: r.deliveryCharges,
    freightInr: r.freightInr != null ? r.freightInr : r.deliveryCharges,
    codFeeInr: Number(r.codFeeInr) || 0,
    isDeliverable: r.isDeliverable,
    estimatedDays: r.estimatedDays,
    courierName: r.courierName,
    courierCompanyId: r.courierCompanyId,
    shipmozoCourierId: r.shipmozoCourierId || (r.provider === 'shipmozo' ? r.courierCompanyId : null),
    codAvailable: r.codAvailable,
    message: r.message,
    mock: r.mock,
    provider: r.provider || r.shippingProvider,
    shippingProvider: r.shippingProvider || r.provider
  };
}

module.exports = {
  checkDeliveryAvailabilityForActiveProvider,
  getDeliveryChargesForActiveProvider,
  sanitizeCustomerFacingDeliveryResult
};
