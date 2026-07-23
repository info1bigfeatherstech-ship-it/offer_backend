const Address = require('../models/Address');
const CheckoutQuote = require('../models/CheckoutQuote');
const mongoose = require('mongoose');
const {
  computeCheckoutTotals,
  roundMoney2,
  cartFingerprintFromItems,
  evaluateCartForCheckout,
  resolveCouponDiscount,
  calculateTax
} = require('../services/checkoutComputation.service');
const {
  normalizePaymentMethod,
  normalizeBalanceCollection,
  resolveAdvancePaymentSelectionWithPolicy,
  createInvalidPaymentMethodError,
  createQuoteExpiredError,
  createQuoteStaleError,
  sendCheckoutFlowError,
  buildRequestLogContext
} = require('../utils/checkoutFlow');
const checkoutSettingsService = require('../services/checkoutSettings.service');
const {
  isAdvanceBalanceCodCheckout,
  assertStorePolicyAllowsCheckout,
  validateCarrierCodForCheckout,
  buildClientCodAvailability
} = require('../utils/checkoutPaymentPolicy');
const { sanitizeCartItems } = require('../services/cartSanitize.service');
const { findCartForStorefront } = require('../services/cartStorefront.service');
const { addressBelongsToStorefront } = require('../utils/customerStorefrontScope');
const logger = require('../utils/logger');

const QUOTE_TTL_MS = 15 * 60 * 1000;

const normalizePin = (p) => String(p || '').replace(/\D/g, '').slice(0, 6);
const normalizeDecisionCode = (errorLike, fallback) =>
  String(errorLike?.code || fallback || 'CHECKOUT_FLOW_ERROR').trim().toUpperCase();

const respondCheckoutInputError = (res, status, code, message, extras = {}) =>
  res.status(status).json({
    success: false,
    code,
    message,
    ...extras
  });

function allowDemoMockShipping(req) {
  if (req.body?.demoMockShipping !== true) return false;
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_CHECKOUT_DEMO_MOCK !== 'true') {
    return false;
  }
  return true;
}

/**
 * @param {'cod_full'|'online'|'advance_balance_cod'} shiprocketPricingMode — how Shiprocket COD amount is derived for quotes
 * @param {number|null} advancePercentForBalanceCod — admin advance % when mode is advance_balance_cod
 */
async function buildFinalTotals({
  cartDoc,
  pin,
  finalUserType,
  storefront,
  couponCode,
  paymentMethodHint,
  req,
  shiprocketPricingMode = 'online',
  advancePercentForBalanceCod = null
}) {
  if (allowDemoMockShipping(req)) {
    const evaluated = await evaluateCartForCheckout(cartDoc, finalUserType, null, storefront);
    const { discount, appliedCouponCode } = await resolveCouponDiscount(
      couponCode,
      evaluated.subtotal,
      finalUserType,
      null,
      { consumeUsage: false }
    );
    const deliveryCharges = roundMoney2(35 + Math.floor(Math.random() * 56));
    const tax = calculateTax(evaluated.lines);
    const totalAmount = roundMoney2(evaluated.subtotal + deliveryCharges + tax - discount);
    return {
      ...evaluated,
      discount,
      appliedCouponCode,
      deliveryCharges,
      tax,
      totalAmount,
      deliveryMeta: {
        estimatedDays: String(2 + Math.floor(Math.random() * 3)) + '-5',
        courierName: 'Demo courier (Shiprocket off)',
        courierCompanyId: null,
        isDeliverable: true,
        codAvailable: true,
        mock: true
      }
    };
  }

  let last = await computeCheckoutTotals({
    cart: cartDoc,
    postalCode: pin,
    finalUserType,
    storefront,
    couponCode,
    session: null,
    consumeCoupon: false,
    codAmountForShiprocket: 0
  });

  if (shiprocketPricingMode === 'cod_full') {
    for (let i = 0; i < 2; i++) {
      const codVal = roundMoney2(last.subtotal + last.tax - last.discount + last.deliveryCharges);
      last = await computeCheckoutTotals({
        cart: cartDoc,
        postalCode: pin,
        finalUserType,
        storefront,
        couponCode,
        session: null,
        consumeCoupon: false,
        codAmountForShiprocket: codVal
      });
    }
  } else if (shiprocketPricingMode === 'advance_balance_cod') {
    const pct = Number(advancePercentForBalanceCod);
    if (!Number.isFinite(pct) || pct < 1 || pct > 100) {
      const err = new Error('Invalid advance percent for hybrid COD quote');
      err.statusCode = 500;
      err.code = 'CHECKOUT_POLICY_INVALID';
      throw err;
    }
    for (let i = 0; i < 2; i++) {
      const totalInr = roundMoney2(last.subtotal + last.tax - last.discount + last.deliveryCharges);
      const advInrRaw = roundMoney2((totalInr * pct) / 100);
      const advInr = Math.max(1, Math.min(roundMoney2(totalInr - 0.01), advInrRaw));
      const balanceCod = roundMoney2(totalInr - advInr);
      last = await computeCheckoutTotals({
        cart: cartDoc,
        postalCode: pin,
        finalUserType,
        storefront,
        couponCode,
        session: null,
        consumeCoupon: false,
        codAmountForShiprocket: balanceCod
      });
    }
  }

  return last;
}

/**
 * POST /api/checkout/quote
 */
exports.quoteCheckout = async (req, res) => {
  try {
    const userId = req.userId;
    const finalUserType = req.userType === 'wholesaler' ? 'wholesaler' : 'normal';
    const storefront = req.storefront || 'ecomm';
    const {
      addressId,
      couponCode,
      paymentMethodHint,
      paymentPlan,
      paymentAdvancePercent,
      balanceCollection,
      quotePurpose
    } = req.body || {};
    const isComparisonQuote = String(quotePurpose || '').toLowerCase() === 'cod_comparison';

    const checkoutPolicy = await checkoutSettingsService.getPolicyForStorefront(storefront);

    let normalizedQuotePlan = 'full';
    try {
      const sel = resolveAdvancePaymentSelectionWithPolicy({
        paymentPlan,
        paymentAdvancePercent,
        policy: checkoutPolicy
      });
      normalizedQuotePlan = sel.normalizedPaymentPlan;
    } catch (policyErr) {
      if (policyErr?.statusCode && policyErr?.code) {
        return sendCheckoutFlowError(res, policyErr, policyErr.message, policyErr.code);
      }
      throw policyErr;
    }

    const normalizedBalanceCollection = normalizeBalanceCollection(balanceCollection);

    let hintedMethod = 'online';
    if (paymentMethodHint !== undefined && paymentMethodHint !== null && String(paymentMethodHint).trim() !== '') {
      hintedMethod = normalizePaymentMethod(paymentMethodHint);
      if (!hintedMethod) {
        throw createInvalidPaymentMethodError();
      }
    }

    try {
      assertStorePolicyAllowsCheckout({
        policy: checkoutPolicy,
        paymentMethod: hintedMethod === 'cod' ? 'cod' : 'online',
        paymentPlan: normalizedQuotePlan,
        balanceCollection: normalizedBalanceCollection
      });
    } catch (policyErr) {
      if (policyErr?.statusCode && policyErr?.code) {
        return sendCheckoutFlowError(res, policyErr, policyErr.message, policyErr.code);
      }
      throw policyErr;
    }

    const isAdvanceBalanceCod = isAdvanceBalanceCodCheckout({
      paymentMethod: hintedMethod === 'cod' ? 'cod' : 'online',
      paymentPlan: normalizedQuotePlan,
      balanceCollection: normalizedBalanceCollection
    });

    let shiprocketPricingMode = 'online';
    if (hintedMethod === 'cod') {
      shiprocketPricingMode = 'cod_full';
    } else if (isAdvanceBalanceCod) {
      shiprocketPricingMode = 'advance_balance_cod';
    }

    const advancePctForSr =
      isAdvanceBalanceCod && checkoutPolicy.partialPaymentPercent != null
        ? Number(checkoutPolicy.partialPaymentPercent)
        : isAdvanceBalanceCod
          ? 25
          : null;

    if (!addressId) {
      return respondCheckoutInputError(res, 400, 'ADDRESS_ID_REQUIRED', 'addressId is required');
    }
    if (!mongoose.Types.ObjectId.isValid(String(addressId))) {
      return respondCheckoutInputError(res, 400, 'INVALID_ADDRESS_ID', 'Invalid addressId');
    }

    if (req.body?.demoMockShipping === true && !allowDemoMockShipping(req)) {
      return res.status(400).json({
        success: false,
        code: 'DEMO_MOCK_SHIPPING_DISABLED',
        message: 'demoMockShipping is not enabled in this environment'
      });
    }

    const address = await Address.findById(addressId).lean();
    if (
      !address ||
      String(address.userId) !== String(userId) ||
      !addressBelongsToStorefront(address, storefront)
    ) {
      return respondCheckoutInputError(res, 404, 'ADDRESS_NOT_FOUND', 'Address not found');
    }

    const pin = normalizePin(address.postalCode);
    if (pin.length !== 6) {
      return respondCheckoutInputError(res, 400, 'INVALID_POSTAL_CODE', 'Address must have a valid 6-digit postal code');
    }

    const cartDoc = await findCartForStorefront(userId, storefront);
    if (!cartDoc?.items?.length) {
      return respondCheckoutInputError(res, 400, 'CART_EMPTY', 'cart is empty');
    }

    const { removed: removedCartLines } = await sanitizeCartItems(cartDoc, storefront, {
      persist: true
    });
    if (removedCartLines.length > 0) {
      logger.warn('quoteCheckout removed stale cart lines', {
        userId: String(userId),
        removedCount: removedCartLines.length
      });
    }
    if (!cartDoc.items.length) {
      return respondCheckoutInputError(
        res,
        400,
        'CART_EMPTY',
        'Your cart had outdated items that were removed. Please add products again.'
      );
    }

    const finalTotals = await buildFinalTotals({
      cartDoc,
      pin,
      finalUserType,
      storefront,
      couponCode,
      paymentMethodHint,
      req,
      shiprocketPricingMode,
      advancePercentForBalanceCod: advancePctForSr
    });

    const fp = cartFingerprintFromItems(cartDoc.items);
    const quoteExpiresAt = new Date(Date.now() + QUOTE_TTL_MS);
    const couponCodeUpper = couponCode ? String(couponCode).toUpperCase().trim() : '';

    if (isComparisonQuote) {
      return res.json({
        success: true,
        previewOnly: true,
        quoteId: null,
        isDeliverable: true,
        ...buildClientCodAvailability({
          policy: checkoutPolicy,
          carrierCodAvailable: finalTotals.deliveryMeta?.codAvailable !== false
        }),
        checkoutPolicy,
        pincode: pin,
        itemCount: cartDoc.items.length,
        itemsSubtotal: finalTotals.subtotal,
        promotionDiscount: finalTotals.discount,
        deliveryCharges: finalTotals.deliveryCharges,
        taxes: finalTotals.tax,
        amountPayable: finalTotals.totalAmount,
        includesShippingAndHandling: true,
        couponApplied: finalTotals.appliedCouponCode
      });
    }

    await CheckoutQuote.updateMany(
      {
        userId,
        status: { $in: ['active', 'confirmed'] }
      },
      {
        $set: {
          status: 'expired',
          lastValidatedAt: new Date()
        }
      }
    );

    cartDoc.deliverySnapshot = {
      addressId,
      postalCode: pin,
      quotedAt: new Date(),
      cartFingerprint: fp,
      isDeliverable: true,
      deliveryCharges: finalTotals.deliveryCharges,
      estimatedDays: finalTotals.deliveryMeta?.estimatedDays,
      courierName: finalTotals.deliveryMeta?.courierName,
      courierCompanyId:
        finalTotals.deliveryMeta?.courierCompanyId != null &&
        Number.isFinite(Number(finalTotals.deliveryMeta.courierCompanyId))
          ? Number(finalTotals.deliveryMeta.courierCompanyId)
          : null,
      weightKg: finalTotals.totalWeight,
      dims: finalTotals.dims,
      couponCodeUpper,
      ttlMs: QUOTE_TTL_MS,
      mockShipping: Boolean(allowDemoMockShipping(req))
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
      itemsSubtotal: finalTotals.subtotal,
      promotionDiscount: finalTotals.discount,
      deliveryCharges: finalTotals.deliveryCharges,
      taxes: finalTotals.tax,
      amountPayable: finalTotals.totalAmount,
      shippingMeta: {
        isDeliverable: true,
        estimatedDays: finalTotals.deliveryMeta?.estimatedDays || null,
        courierName: finalTotals.deliveryMeta?.courierName || null,
        courierCompanyId: finalTotals.deliveryMeta?.courierCompanyId || null,
        codAvailable: finalTotals.deliveryMeta?.codAvailable !== false,
        message: 'Delivery available',
        mock: Boolean(finalTotals.deliveryMeta?.mock),
        // Stored on quote for order create / admin RTO only — not returned to storefront UI below.
        freightInr:
          finalTotals.deliveryMeta?.freightInr != null
            ? roundMoney2(Number(finalTotals.deliveryMeta.freightInr))
            : null,
        codFeeInr:
          finalTotals.deliveryMeta?.codFeeInr != null
            ? roundMoney2(Number(finalTotals.deliveryMeta.codFeeInr))
            : null
      },
      totalWeightKg: finalTotals.totalWeight,
      dims: finalTotals.dims,
      status: 'active',
      quoteExpiresAt
    });

    logger.info('Checkout quote created', buildRequestLogContext(req, {
      quoteId: String(quote._id),
      cartFingerprint: fp,
      paymentMethodHint: paymentMethodHint || null
    }));

    const eta =
      finalTotals.deliveryMeta?.estimatedDays != null
        ? `Estimated delivery in ${finalTotals.deliveryMeta.estimatedDays} business days`
        : 'Delivery timeline will be confirmed after dispatch';

    return res.json({
      success: true,
      quoteId: quote._id,
      isDeliverable: true,
      ...buildClientCodAvailability({
        policy: checkoutPolicy,
        carrierCodAvailable: quote.shippingMeta.codAvailable
      }),
      checkoutPolicy,
      deliveryEstimate: eta,
      courierName: finalTotals.deliveryMeta?.courierName || null,
      pincode: pin,
      itemCount: cartDoc.items.length,
      itemsSubtotal: finalTotals.subtotal,
      promotionDiscount: finalTotals.discount,
      deliveryCharges: finalTotals.deliveryCharges,
      taxes: finalTotals.tax,
      amountPayable: finalTotals.totalAmount,
      includesShippingAndHandling: true,
      couponApplied: finalTotals.appliedCouponCode,
      quoteExpiresAt: quoteExpiresAt.toISOString(),
      cartFingerprint: fp,
      demoMockShipping: Boolean(allowDemoMockShipping(req))
    });
  } catch (err) {
    if (err.statusCode) {
      logger.warn('quoteCheckout business rejection', buildRequestLogContext(req, {
        code: normalizeDecisionCode(err, 'QUOTE_BUILD_REJECTED'),
        reason: err?.details?.reason || null,
        statusCode: err.statusCode
      }));
      return sendCheckoutFlowError(res, err, 'Failed to build checkout quote', 'QUOTE_BUILD_FAILED');
    }
    logger.error('quoteCheckout failed', buildRequestLogContext(req, {
      error: err.message,
      stack: err.stack
    }));
    return res.status(500).json({
      success: false,
      code: 'QUOTE_BUILD_FAILED',
      message: 'Failed to build checkout quote'
    });
  }
};

/**
 * POST /api/checkout/confirm
 * Re-validates quote against latest cart/coupon/shipping before creating payment intent/order.
 */
exports.confirmCheckout = async (req, res) => {
  try {
    const userId = req.userId;
    const finalUserType = req.userType === 'wholesaler' ? 'wholesaler' : 'normal';
    const storefront = req.storefront || 'ecomm';
    const { quoteId, paymentMethod, paymentPlan, paymentAdvancePercent, balanceCollection } = req.body || {};

    if (!quoteId) {
      return respondCheckoutInputError(res, 400, 'QUOTE_ID_REQUIRED', 'quoteId is required');
    }
    if (!mongoose.Types.ObjectId.isValid(String(quoteId))) {
      return respondCheckoutInputError(res, 400, 'INVALID_QUOTE_ID', 'Invalid quoteId');
    }

    const normalizedPaymentMethod = normalizePaymentMethod(paymentMethod);
    if (!normalizedPaymentMethod) {
      throw createInvalidPaymentMethodError();
    }

    const checkoutPolicy = await checkoutSettingsService.getPolicyForStorefront(storefront);

    let normalizedPaymentPlan;
    let effectiveAdvancePercent;
    try {
      const sel = resolveAdvancePaymentSelectionWithPolicy({
        paymentPlan,
        paymentAdvancePercent,
        policy: checkoutPolicy
      });
      normalizedPaymentPlan = sel.normalizedPaymentPlan;
      effectiveAdvancePercent = sel.effectiveAdvancePercent;
    } catch (policyErr) {
      if (policyErr?.statusCode && policyErr?.code) {
        return sendCheckoutFlowError(res, policyErr, policyErr.message, policyErr.code);
      }
      throw policyErr;
    }

    const normalizedBalanceCollection = normalizeBalanceCollection(balanceCollection);
    if (normalizedPaymentPlan !== 'advance' && normalizedBalanceCollection === 'cod') {
      return respondCheckoutInputError(
        res,
        400,
        'INVALID_BALANCE_COLLECTION',
        'Pay on delivery for the balance applies only when using partial pay now.'
      );
    }

    const isAdvanceBalanceCod = isAdvanceBalanceCodCheckout({
      paymentMethod: normalizedPaymentMethod,
      paymentPlan: normalizedPaymentPlan,
      balanceCollection: normalizedBalanceCollection
    });

    try {
      assertStorePolicyAllowsCheckout({
        policy: checkoutPolicy,
        paymentMethod: normalizedPaymentMethod,
        paymentPlan: normalizedPaymentPlan,
        balanceCollection: normalizedBalanceCollection
      });
    } catch (policyErr) {
      if (policyErr?.statusCode && policyErr?.code) {
        return sendCheckoutFlowError(res, policyErr, policyErr.message, policyErr.code);
      }
      throw policyErr;
    }

    const quote = await CheckoutQuote.findOne({ _id: quoteId, userId, status: 'active' });
    if (!quote) {
      return respondCheckoutInputError(res, 404, 'QUOTE_NOT_FOUND', 'Quote not found or inactive');
    }

    if (quote.quoteExpiresAt.getTime() <= Date.now()) {
      quote.status = 'expired';
      await quote.save();
      throw createQuoteExpiredError();
    }

    const address = await Address.findById(quote.addressId).lean();
    if (
      !address ||
      String(address.userId) !== String(userId) ||
      !addressBelongsToStorefront(address, storefront)
    ) {
      return respondCheckoutInputError(res, 400, 'QUOTE_ADDRESS_INVALID', 'Address is no longer valid for this quote');
    }

    const pin = normalizePin(address.postalCode);
    if (pin.length !== 6 || pin !== quote.postalCode) {
      return respondCheckoutInputError(res, 400, 'QUOTE_POSTAL_CODE_CHANGED', 'Address pincode changed. Regenerate quote.');
    }

    const cartDoc = await findCartForStorefront(userId, storefront);
    if (!cartDoc?.items?.length) {
      return respondCheckoutInputError(res, 400, 'CART_EMPTY', 'Cart is empty. Regenerate quote.');
    }

    await sanitizeCartItems(cartDoc, storefront, { persist: true });
    if (!cartDoc.items.length) {
      return respondCheckoutInputError(res, 400, 'CART_EMPTY', 'Cart is empty. Regenerate quote.');
    }

    const fp = cartFingerprintFromItems(cartDoc.items);
    if (fp !== quote.cartFingerprint) {
      throw createQuoteStaleError('cart_changed', {
        message: 'Cart changed. Please refresh quote before proceeding.'
      });
    }

    const couponCode = quote.couponCodeUpper || null;

    let shiprocketPricingMode = 'online';
    if (normalizedPaymentMethod === 'cod') {
      shiprocketPricingMode = 'cod_full';
    } else if (isAdvanceBalanceCod) {
      shiprocketPricingMode = 'advance_balance_cod';
    }

    const recomputed = await buildFinalTotals({
      cartDoc,
      pin,
      finalUserType,
      storefront,
      couponCode,
      paymentMethodHint: normalizedPaymentMethod === 'cod' ? 'cod' : 'online',
      req: { body: { demoMockShipping: Boolean(quote.shippingMeta?.mock) } },
      shiprocketPricingMode,
      advancePercentForBalanceCod: isAdvanceBalanceCod ? effectiveAdvancePercent : null
    });

    const carrierCodCheck = validateCarrierCodForCheckout({
      carrierCodAvailable: recomputed.deliveryMeta?.codAvailable,
      paymentMethod: normalizedPaymentMethod,
      paymentPlan: normalizedPaymentPlan,
      balanceCollection: normalizedBalanceCollection
    });
    if (!carrierCodCheck.ok) {
      return res.status(carrierCodCheck.statusCode).json({
        success: false,
        code: carrierCodCheck.code,
        message: carrierCodCheck.message
      });
    }

    const mismatch =
      roundMoney2(quote.itemsSubtotal) !== roundMoney2(recomputed.subtotal) ||
      roundMoney2(quote.promotionDiscount) !== roundMoney2(recomputed.discount) ||
      roundMoney2(quote.deliveryCharges) !== roundMoney2(recomputed.deliveryCharges) ||
      roundMoney2(quote.taxes) !== roundMoney2(recomputed.tax) ||
      roundMoney2(quote.amountPayable) !== roundMoney2(recomputed.totalAmount);

    if (mismatch) {
      throw createQuoteStaleError('pricing_changed', {
        message: 'Pricing changed since quote creation. Please refresh quote before proceeding.',
        details: {
          latest: {
            itemsSubtotal: recomputed.subtotal,
            promotionDiscount: recomputed.discount,
            deliveryCharges: recomputed.deliveryCharges,
            taxes: recomputed.tax,
            amountPayable: recomputed.totalAmount,
            codAvailable: recomputed.deliveryMeta?.codAvailable !== false
          }
        }
      });
    }

    quote.lastValidatedAt = new Date();
    quote.status = 'confirmed';
    quote.confirmedAt = new Date();
    quote.confirmedPaymentMethod = normalizedPaymentMethod;
    quote.confirmedPaymentPlan = normalizedPaymentPlan;
    quote.confirmedAdvancePercent = normalizedPaymentPlan === 'advance'
      ? effectiveAdvancePercent
      : null;
    quote.confirmedBalanceCollection =
      normalizedPaymentPlan === 'advance' ? (isAdvanceBalanceCod ? 'cod' : 'online') : '';
    await quote.save();

    logger.info('Checkout quote confirmed', buildRequestLogContext(req, {
      quoteId: String(quote._id),
      paymentMethod: normalizedPaymentMethod,
      paymentPlan: normalizedPaymentPlan,
      paymentAdvancePercent: normalizedPaymentPlan === 'advance' ? effectiveAdvancePercent : null
    }));

    return res.json({
      success: true,
      quoteId: quote._id,
      validated: true,
      paymentMethod: normalizedPaymentMethod,
      paymentPlan: normalizedPaymentPlan,
      checkoutPolicy,
      ...buildClientCodAvailability({
        policy: checkoutPolicy,
        carrierCodAvailable: recomputed.deliveryMeta?.codAvailable
      }),
      totals: {
        itemCount: cartDoc.items.length,
        itemsSubtotal: recomputed.subtotal,
        promotionDiscount: recomputed.discount,
        deliveryCharges: recomputed.deliveryCharges,
        taxes: recomputed.tax,
        amountPayable: recomputed.totalAmount
      },
      next: {
        createOrderEndpoint: '/api/orders/items',
        payload: {
          addressId: String(quote.addressId),
          paymentMethod: normalizedPaymentMethod === 'cod' ? 'cod' : 'online',
          onlinePaymentMode: normalizedPaymentPlan,
          paymentAdvancePercent: normalizedPaymentPlan === 'advance' ? effectiveAdvancePercent : undefined,
          balanceCollection:
            normalizedPaymentPlan === 'advance'
              ? (isAdvanceBalanceCod ? 'cod' : 'online')
              : undefined,
          couponCode: quote.couponCodeUpper || undefined,
          quoteId: String(quote._id)
        }
      }
    });
  } catch (err) {
    if (err.statusCode) {
      logger.warn('confirmCheckout business rejection', buildRequestLogContext(req, {
        code: normalizeDecisionCode(err, 'QUOTE_CONFIRM_REJECTED'),
        reason: err?.details?.reason || null,
        statusCode: err.statusCode
      }));
      return sendCheckoutFlowError(res, err, 'Failed to confirm checkout quote', 'QUOTE_CONFIRM_FAILED');
    }
    logger.error('confirmCheckout failed', buildRequestLogContext(req, {
      error: err.message,
      stack: err.stack
    }));
    return res.status(500).json({
      success: false,
      code: 'QUOTE_CONFIRM_FAILED',
      message: 'Failed to confirm checkout quote'
    });
  }
};
