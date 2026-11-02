'use strict';

/**
 * Same-day checkout totals — cart + coupon + tax only.
 * Uses deliveryChargesOverride=0 so computeCheckoutTotals never calls courier APIs.
 */

const mongoose = require('mongoose');
const Address = require('../../models/Address');
const CheckoutQuote = require('../../models/CheckoutQuote');
const {
  computeCheckoutTotals,
  roundMoney2,
  cartFingerprintFromItems,
} = require('../../services/checkoutComputation.service');
const { sanitizeCartItems } = require('../../services/cartSanitize.service');
const { findCartForStorefront } = require('../../services/cartStorefront.service');
const { addressBelongsToStorefront } = require('../../utils/customerStorefrontScope');
const { pricingUserTypeForStorefront } = require('../../utils/accountScope');
const { assertPincodeEligible } = require('./sameDayDeliverySettings.service');
const {
  createSddHttpError,
  normalizePincode,
  isValidPincode,
} = require('../utils/sameDayDeliveryMode');

const QUOTE_TTL_MS = 15 * 60 * 1000;

const SDD_DELIVERY_META = Object.freeze({
  isDeliverable: true,
  codAvailable: false,
  courierName: null,
  courierCompanyId: null,
  shipmozoCourierId: null,
  shippingProvider: null,
  estimatedDays: null,
  pickupsAutomaticallyScheduled: null,
  mock: false,
  freightInr: 0,
  codFeeInr: 0,
});

function assertEcommStorefront(storefront) {
  if (String(storefront || 'ecomm') !== 'ecomm') {
    throw createSddHttpError(
      400,
      'SAME_DAY_ECOMM_ONLY',
      'Same day delivery is only available on the ecomm store.',
      'deliveryMode'
    );
  }
}

async function computeSameDayTotals({
  cartDoc,
  pin,
  finalUserType,
  storefront,
  couponCode,
  session = null,
  consumeCoupon = false,
}) {
  return computeCheckoutTotals({
    cart: cartDoc,
    postalCode: pin,
    finalUserType,
    storefront,
    couponCode,
    session,
    consumeCoupon,
    deliveryChargesOverride: 0,
    deliveryMetaOverride: { ...SDD_DELIVERY_META },
  });
}

async function loadOwnedAddress({ userId, addressId, storefront }) {
  if (!addressId) {
    throw createSddHttpError(400, 'ADDRESS_ID_REQUIRED', 'addressId is required', 'addressId');
  }
  if (!mongoose.Types.ObjectId.isValid(String(addressId))) {
    throw createSddHttpError(400, 'INVALID_ADDRESS_ID', 'Invalid addressId', 'addressId');
  }
  const address = await Address.findById(addressId).lean();
  if (
    !address ||
    String(address.userId) !== String(userId) ||
    !addressBelongsToStorefront(address, storefront)
  ) {
    throw createSddHttpError(404, 'ADDRESS_NOT_FOUND', 'Address not found', 'addressId');
  }
  const pin = normalizePincode(address.postalCode);
  if (!isValidPincode(pin)) {
    throw createSddHttpError(
      400,
      'INVALID_POSTAL_CODE',
      'Address must have a valid 6-digit postal code',
      'postalCode'
    );
  }
  return { address, pin };
}

async function loadSanitizedCart(userId, storefront) {
  const cartDoc = await findCartForStorefront(userId, storefront);
  if (!cartDoc?.items?.length) {
    throw createSddHttpError(400, 'CART_EMPTY', 'cart is empty');
  }
  const { removed } = await sanitizeCartItems(cartDoc, storefront, { persist: true });
  if (!cartDoc.items.length) {
    throw createSddHttpError(
      400,
      'CART_EMPTY',
      'Your cart had outdated items that were removed. Please add products again.'
    );
  }
  return { cartDoc, removedCount: removed.length };
}

async function quoteSameDayCheckout({ userId, storefront, addressId, couponCode }) {
  assertEcommStorefront(storefront);
  const finalUserType = pricingUserTypeForStorefront(storefront);
  const { pin } = await loadOwnedAddress({ userId, addressId, storefront });
  await assertPincodeEligible(pin);
  const { cartDoc } = await loadSanitizedCart(userId, storefront);

  const totals = await computeSameDayTotals({
    cartDoc,
    pin,
    finalUserType,
    storefront,
    couponCode,
    consumeCoupon: false,
  });

  const fp = cartFingerprintFromItems(cartDoc.items);
  const quoteExpiresAt = new Date(Date.now() + QUOTE_TTL_MS);
  const couponCodeUpper = couponCode ? String(couponCode).toUpperCase().trim() : '';

  await CheckoutQuote.updateMany(
    { userId, status: { $in: ['active', 'confirmed'] } },
    { $set: { status: 'expired', lastValidatedAt: new Date() } }
  );

  cartDoc.deliverySnapshot = {
    addressId,
    postalCode: pin,
    quotedAt: new Date(),
    cartFingerprint: fp,
    isDeliverable: true,
    deliveryCharges: 0,
    estimatedDays: null,
    courierName: null,
    courierCompanyId: null,
    weightKg: totals.totalWeight,
    dims: totals.dims,
    couponCodeUpper,
    ttlMs: QUOTE_TTL_MS,
    mockShipping: false,
    deliveryMode: 'same_day',
  };
  await cartDoc.save();

  const quote = await CheckoutQuote.create({
    userId,
    addressId,
    postalCode: pin,
    couponCodeUpper,
    cartFingerprint: fp,
    userType: finalUserType,
    itemCount: cartDoc.items.length,
    itemsSubtotal: totals.subtotal,
    promotionDiscount: totals.discount,
    deliveryCharges: 0,
    taxes: totals.tax,
    amountPayable: totals.totalAmount,
    deliveryMode: 'same_day',
    shippingMeta: {
      ...SDD_DELIVERY_META,
      message: 'Same day delivery — no courier booking',
    },
    totalWeightKg: totals.totalWeight,
    dims: totals.dims,
    status: 'active',
    quoteExpiresAt,
  });

  return {
    quote,
    totals,
    pin,
    itemCount: cartDoc.items.length,
    couponApplied: totals.appliedCouponCode,
    cartFingerprint: fp,
    quoteExpiresAt,
  };
}

async function confirmSameDayCheckout({ userId, storefront, quoteId }) {
  assertEcommStorefront(storefront);
  if (!quoteId || !mongoose.Types.ObjectId.isValid(String(quoteId))) {
    throw createSddHttpError(400, 'INVALID_QUOTE_ID', 'Valid quoteId is required', 'quoteId');
  }

  const quote = await CheckoutQuote.findOne({ _id: quoteId, userId, status: 'active' });
  if (!quote) {
    throw createSddHttpError(404, 'QUOTE_NOT_FOUND', 'Quote not found or inactive', 'quoteId');
  }
  if (String(quote.deliveryMode || '') !== 'same_day') {
    throw createSddHttpError(400, 'NOT_SAME_DAY_QUOTE', 'This quote is not a same-day delivery quote.');
  }
  if (quote.quoteExpiresAt.getTime() <= Date.now()) {
    quote.status = 'expired';
    await quote.save();
    throw createSddHttpError(400, 'QUOTE_EXPIRED', 'Quote expired. Please refresh checkout.');
  }

  const { pin } = await loadOwnedAddress({
    userId,
    addressId: quote.addressId,
    storefront,
  });
  if (pin !== quote.postalCode) {
    throw createSddHttpError(400, 'QUOTE_POSTAL_CODE_CHANGED', 'Address pincode changed. Regenerate quote.');
  }
  await assertPincodeEligible(pin);

  const { cartDoc } = await loadSanitizedCart(userId, storefront);
  const fp = cartFingerprintFromItems(cartDoc.items);
  if (fp !== quote.cartFingerprint) {
    throw createSddHttpError(409, 'QUOTE_STALE', 'Cart changed. Please refresh quote before proceeding.');
  }

  const couponCode = quote.couponCodeUpper || null;
  const finalUserType = pricingUserTypeForStorefront(storefront);
  const recomputed = await computeSameDayTotals({
    cartDoc,
    pin,
    finalUserType,
    storefront,
    couponCode,
    consumeCoupon: false,
  });

  const mismatch =
    roundMoney2(quote.itemsSubtotal) !== roundMoney2(recomputed.subtotal) ||
    roundMoney2(quote.promotionDiscount) !== roundMoney2(recomputed.discount) ||
    roundMoney2(quote.deliveryCharges) !== 0 ||
    roundMoney2(quote.taxes) !== roundMoney2(recomputed.tax) ||
    roundMoney2(quote.amountPayable) !== roundMoney2(recomputed.totalAmount);

  if (mismatch) {
    const err = createSddHttpError(
      409,
      'QUOTE_STALE',
      'Pricing changed since quote creation. Please refresh quote before proceeding.'
    );
    err.details = {
      latest: {
        itemsSubtotal: recomputed.subtotal,
        promotionDiscount: recomputed.discount,
        deliveryCharges: 0,
        taxes: recomputed.tax,
        amountPayable: recomputed.totalAmount,
      },
    };
    throw err;
  }

  quote.lastValidatedAt = new Date();
  quote.status = 'confirmed';
  quote.confirmedAt = new Date();
  quote.confirmedPaymentMethod = 'online';
  quote.confirmedPaymentPlan = 'full';
  quote.confirmedAdvancePercent = null;
  quote.confirmedBalanceCollection = '';
  await quote.save();

  return {
    quote,
    totals: recomputed,
    itemCount: cartDoc.items.length,
  };
}

module.exports = {
  SDD_DELIVERY_META,
  QUOTE_TTL_MS,
  assertEcommStorefront,
  computeSameDayTotals,
  quoteSameDayCheckout,
  confirmSameDayCheckout,
};
