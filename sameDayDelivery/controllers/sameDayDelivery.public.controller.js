'use strict';

const logger = require('../../utils/logger');
const { quoteSameDayCheckout, confirmSameDayCheckout } = require('../services/sameDayCheckout.service');
const { isPincodeEligible } = require('../services/sameDayDeliverySettings.service');
const { normalizePincode, isValidPincode } = require('../utils/sameDayDeliveryMode');
const { addressBelongsToStorefront } = require('../../utils/customerStorefrontScope');
const Address = require('../../models/Address');

function sendSddError(res, err, fallback) {
  const status = err.statusCode && Number.isFinite(err.statusCode) ? err.statusCode : 500;
  const code = err.code || (status === 400 ? 'BAD_REQUEST' : 'INTERNAL_ERROR');
  const message =
    status === 500 && process.env.NODE_ENV === 'production' ? fallback : err.message || fallback;
  if (status >= 500) {
    logger.error('[sdd-public]', { message: err.message, code, stack: err.stack });
  }
  return res.status(status).json({
    success: false,
    code,
    message,
    ...(err.field ? { field: err.field } : {}),
    ...(err.details ? { details: err.details } : {}),
  });
}

exports.getEligibility = async (req, res) => {
  try {
    const storefront = req.storefront || 'ecomm';
    if (storefront !== 'ecomm') {
      return res.json({
        success: true,
        data: { eligible: false, enabled: false, reason: 'SAME_DAY_ECOMM_ONLY' },
      });
    }
    let pin = normalizePincode(req.query.pincode);
    if (!pin && req.query.addressId) {
      const address = await Address.findById(req.query.addressId).lean();
      if (
        address &&
        String(address.userId) === String(req.userId) &&
        addressBelongsToStorefront(address, storefront)
      ) {
        pin = normalizePincode(address.postalCode);
      }
    }
    if (!isValidPincode(pin)) {
      return res.json({
        success: true,
        data: { eligible: false, enabled: false, pincode: pin || null, reason: 'INVALID_PINCODE' },
      });
    }
    const result = await isPincodeEligible(pin);
    return res.json({ success: true, data: result });
  } catch (err) {
    return sendSddError(res, err, 'Could not check same-day eligibility');
  }
};

exports.quoteSameDay = async (req, res) => {
  try {
    const result = await quoteSameDayCheckout({
      userId: req.userId,
      storefront: req.storefront || 'ecomm',
      addressId: req.body?.addressId,
      couponCode: req.body?.couponCode,
    });
    return res.json({
      success: true,
      quoteId: result.quote._id,
      deliveryMode: 'same_day',
      isDeliverable: true,
      codAvailable: false,
      advanceAvailable: false,
      pincode: result.pin,
      itemCount: result.itemCount,
      itemsSubtotal: result.totals.subtotal,
      promotionDiscount: result.totals.discount,
      deliveryCharges: 0,
      taxes: result.totals.tax,
      amountPayable: result.totals.totalAmount,
      includesShippingAndHandling: false,
      couponApplied: result.couponApplied,
      quoteExpiresAt: result.quoteExpiresAt.toISOString(),
      cartFingerprint: result.cartFingerprint,
      paymentMethod: 'online',
      paymentPlan: 'full',
    });
  } catch (err) {
    return sendSddError(res, err, 'Failed to build same-day checkout quote');
  }
};

exports.confirmSameDay = async (req, res) => {
  try {
    const result = await confirmSameDayCheckout({
      userId: req.userId,
      storefront: req.storefront || 'ecomm',
      quoteId: req.body?.quoteId,
    });
    return res.json({
      success: true,
      quoteId: result.quote._id,
      deliveryMode: 'same_day',
      validated: true,
      paymentMethod: 'online',
      paymentPlan: 'full',
      totals: {
        itemCount: result.itemCount,
        itemsSubtotal: result.totals.subtotal,
        promotionDiscount: result.totals.discount,
        deliveryCharges: 0,
        taxes: result.totals.tax,
        amountPayable: result.totals.totalAmount,
      },
      next: {
        createOrderEndpoint: '/api/orders/items',
        payload: {
          addressId: String(result.quote.addressId),
          paymentMethod: 'online',
          onlinePaymentMode: 'full',
          couponCode: result.quote.couponCodeUpper || undefined,
          quoteId: String(result.quote._id),
          deliveryMode: 'same_day',
        },
      },
    });
  } catch (err) {
    return sendSddError(res, err, 'Failed to confirm same-day checkout quote');
  }
};
