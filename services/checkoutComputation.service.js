/**
 * Server-side checkout totals: cart lines from live catalog, coupon math, Shiprocket quote inputs.
 * Used by checkout quote + order creation — never trust client-submitted prices.
 */
const crypto = require('crypto');
const Coupon = require('../models/Coupon');
const Product = require('../models/Product');
const ShiprocketService = require('../utils/shiprocket');
const {
  isProductListedOnStorefront,
  isVariantListedOnStorefront
} = require('../utils/storefrontCatalog');

const roundMoney2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const findVariant = (product, variantId) => {
  if (!product || !product.variants) return null;
  return product.variants.find((v) => String(v._id) === String(variantId));
};

const getStorefrontSpecificPrice = (variant, storefront) => {
  const now = new Date();
  if (storefront === 'wholesale') {
    const wholesaleBase = variant.price?.wholesaleBase || variant.price?.base || 0;
    let wholesaleSale = variant.price?.wholesaleSale || variant.price?.wholesaleBase || wholesaleBase;
    const isWholesaleSaleValid =
      wholesaleSale !== wholesaleBase &&
      (!variant.price?.wholesaleSaleStartDate || now >= variant.price.wholesaleSaleStartDate) &&
      (!variant.price?.wholesaleSaleEndDate || now <= variant.price.wholesaleSaleEndDate);
    return {
      base: wholesaleBase,
      sale: isWholesaleSaleValid ? wholesaleSale : wholesaleBase,
      moq: variant.minimumOrderQuantity || 1
    };
  }
  const base = variant.price?.base || 0;
  let sale = variant.price?.sale || null;
  const isSaleValid =
    sale &&
    sale < base &&
    (!variant.price?.saleStartDate || now >= variant.price.saleStartDate) &&
    (!variant.price?.saleEndDate || now <= variant.price.saleEndDate);
  return { base, sale: isSaleValid ? sale : base, moq: 1 };
};

const couponUserEligible = (coupon, finalUserType) => {
  if (!coupon || !Array.isArray(coupon.applicableUsers)) return false;
  if (finalUserType === 'wholesaler') return coupon.applicableUsers.includes('wholesaler');
  if (finalUserType === 'normal') {
    return coupon.applicableUsers.includes('user') || coupon.applicableUsers.includes('normal');
  }
  return coupon.applicableUsers.includes(finalUserType);
};

const calculateTax = (linesOrSubtotal) => {
  if (Array.isArray(linesOrSubtotal)) {
    const totalTax = linesOrSubtotal.reduce((sum, line) => {
      const gstRate = Number(line?.product?.gstRate);
      if (!Number.isFinite(gstRate) || gstRate <= 0) return sum;
      const itemTotal = Number(line?.itemTotal) || 0;
      return sum + (itemTotal * gstRate) / 100;
    }, 0);
    return roundMoney2(totalTax);
  }

  // Fallback for legacy callers still passing subtotal only.
  const subtotal = Number(linesOrSubtotal) || 0;
  return roundMoney2(subtotal * 0.18);
};

function cartFingerprintFromItems(items) {
  const key = (items || [])
    .map((i) => `${i.productId}:${i.variantId}:${i.quantity}`)
    .sort()
    .join('|');
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 32);
}

/**
 * Aggregate package hints for courier APIs (conservative, not volumetric-optimal).
 */
function aggregateShipping(lines) {
  let totalWeightKg = 0;
  let maxL = 10;
  let maxW = 10;
  let heightStack = 0;

  for (const line of lines) {
    const sh = (line.product && line.product.shipping) || {};
    const w = Math.max(0.05, Number(sh.weight) || 0.5);
    const d = sh.dimensions || {};
    const l = Math.max(1, Number(d.length) || 10);
    const wi = Math.max(1, Number(d.width) || 10);
    const h = Math.max(1, Number(d.height) || 10);
    totalWeightKg += w * line.quantity;
    maxL = Math.max(maxL, l);
    maxW = Math.max(maxW, wi);
    heightStack += h * line.quantity;
  }

  const heightCm = Math.min(200, Math.max(10, heightStack));
  return {
    weightKg: Math.max(0.05, roundMoney2(totalWeightKg)),
    lengthCm: maxL,
    widthCm: maxW,
    heightCm
  };
}

/**
 * @param {import('mongoose').Document} cart
 * @param {'normal'|'wholesaler'} finalUserType
 * @param {import('mongoose').ClientSession|null} session
 * @returns {Promise<{ lines: any[], subtotal: number, orderItems: any[], totalWeight: number, dims: object, fingerprint: string }>}
 */
async function evaluateCartForCheckout(cart, finalUserType, session = null, storefront = 'ecomm') {
  if (!cart?.items?.length) {
    const err = new Error('Cart is empty');
    err.statusCode = 400;
    throw err;
  }

  const lines = [];
  let subtotal = 0;
  let totalWeight = 0;
  const orderItems = [];

  for (const cartItem of cart.items) {
    let pq = Product.findById(cartItem.productId).select(
      'name slug variants shipping hsnCode gstRate isFragile status channelStatus'
    );
    if (session) pq = pq.session(session);
    const product = await pq;
    if (!product) {
      const err = new Error('Product not available');
      err.statusCode = 404;
      throw err;
    }

    if (!isProductListedOnStorefront(product, storefront)) {
      const err = new Error('Product not available on this storefront');
      err.statusCode = 404;
      err.code = 'PRODUCT_NOT_AVAILABLE_ON_STOREFRONT';
      throw err;
    }

    const variant = findVariant(product, cartItem.variantId);
    if (!variant || !isVariantListedOnStorefront(variant, storefront)) {
      const err = new Error('Variant not found');
      err.statusCode = 404;
      err.code = 'VARIANT_NOT_AVAILABLE_ON_STOREFRONT';
      throw err;
    }

    if (variant.inventory?.trackInventory && variant.inventory.quantity < cartItem.quantity) {
      const err = new Error(`${product.name} has only ${variant.inventory.quantity} in stock`);
      err.statusCode = 400;
      throw err;
    }

    const price = getStorefrontSpecificPrice(variant, storefront);
    if (storefront === 'wholesale' && cartItem.quantity < price.moq) {
      const err = new Error(`Minimum order quantity for ${product.name} is ${price.moq}`);
      err.statusCode = 400;
      throw err;
    }

    const itemTotal = roundMoney2(price.sale * cartItem.quantity);
    subtotal += itemTotal;
    totalWeight += cartItem.quantity * (product.shipping?.weight || 0.5);

    lines.push({ product, variant, quantity: cartItem.quantity, itemTotal });
    orderItems.push({
      productId: product._id,
      variantId: variant._id,
      quantity: cartItem.quantity,
      priceSnapshot: {
        base: price.base,
        sale: price.sale,
        total: itemTotal
      },
      variantAttributesSnapshot: cartItem.variantAttributesSnapshot || [],
      userType: finalUserType,
        hsnCode: product.hsnCode,
        gstRate: product.gstRate,
        isFragile: product.isFragile || false
    });
  }

  const dims = aggregateShipping(lines);

  const fingerprint = cartFingerprintFromItems(cart.items);

  return {
    lines,
    subtotal: roundMoney2(subtotal),
    orderItems,
    totalWeight: Math.max(0.05, roundMoney2(totalWeight)),
    dims,
    fingerprint
  };
}

async function resolveCouponDiscount(couponCode, subtotal, finalUserType, session, { consumeUsage }) {
  let discount = 0;
  let appliedCouponCode = null;
  if (!couponCode || !String(couponCode).trim()) {
    return { discount, appliedCouponCode, couponDoc: null };
  }

  let cq = Coupon.findOne({ code: String(couponCode).toUpperCase().trim(), isActive: true });
  if (session) cq = cq.session(session);
  const coupon = await cq;

  if (!coupon) {
    return { discount, appliedCouponCode, couponDoc: null };
  }

  const isExpired = coupon.expiryDate && coupon.expiryDate < new Date();
  const meetsMinOrder = !coupon.minOrderValue || subtotal >= coupon.minOrderValue;
  const isUserEligible = couponUserEligible(coupon, finalUserType);
  const usageLimit = Number(coupon.usageLimit);
  const isUsageLimited = Number.isFinite(usageLimit) && usageLimit > 0;
  const hasUsageLeft = !isUsageLimited || Number(coupon.usedCount || 0) < usageLimit;

  if (!isExpired && meetsMinOrder && isUserEligible && hasUsageLeft) {
    if (coupon.discountType === 'percentage') {
      discount = (subtotal * coupon.discountValue) / 100;
      if (coupon.maxDiscountAmount && discount > coupon.maxDiscountAmount) {
        discount = coupon.maxDiscountAmount;
      }
    } else {
      discount = coupon.discountValue;
    }
    discount = roundMoney2(Math.min(discount, subtotal));
    appliedCouponCode = coupon.code;

    if (consumeUsage) {
      const usageFilter = { _id: coupon._id };
      if (isUsageLimited) {
        usageFilter.usedCount = { $lt: usageLimit };
      }

      let uq = Coupon.updateOne(usageFilter, { $inc: { usedCount: 1 } });
      if (session) uq = uq.session(session);
      const usageResult = await uq;
      if (usageResult.modifiedCount !== 1) {
        const err = new Error('Coupon usage limit has been reached');
        err.statusCode = 409;
        err.code = 'COUPON_USAGE_EXHAUSTED';
        throw err;
      }
    }
  }

  return { discount, appliedCouponCode, couponDoc: coupon };
}

/**
 * Full pricing + Shiprocket for a pincode.
 */
async function computeCheckoutTotals({
  cart,
  postalCode,
  finalUserType,
  storefront = 'ecomm',
  couponCode,
  session,
  consumeCoupon,
  codAmountForShiprocket = 0,
  deliveryChargesOverride = null,
  deliveryMetaOverride = null
}) {
  const evaluated = await evaluateCartForCheckout(cart, finalUserType, session, storefront);
  const { discount, appliedCouponCode } = await resolveCouponDiscount(
    couponCode,
    evaluated.subtotal,
    finalUserType,
    session,
    { consumeUsage: consumeCoupon }
  );

  let deliveryCharges;
  let deliveryMeta;

  if (deliveryChargesOverride != null && Number.isFinite(Number(deliveryChargesOverride))) {
    deliveryCharges = roundMoney2(Number(deliveryChargesOverride));
    deliveryMeta = deliveryMetaOverride || {
      estimatedDays: null,
      courierName: null,
      isDeliverable: true,
      codAvailable: true,
      mock: false
    };
  } else {
    const ship = await ShiprocketService.checkDeliveryAvailability(postalCode, {
      weightKg: evaluated.totalWeight,
      lengthCm: evaluated.dims.lengthCm,
      widthCm: evaluated.dims.widthCm,
      heightCm: evaluated.dims.heightCm,
      codAmount: codAmountForShiprocket
    });

    if (!ship.isDeliverable) {
      const err = new Error(ship.message || 'Delivery not available for this pincode');
      err.statusCode = 400;
      err.code = 'NOT_SERVICEABLE';
      throw err;
    }

    deliveryCharges = roundMoney2(Number(ship.deliveryCharges) || 0);
    deliveryMeta = {
      estimatedDays: ship.estimatedDays,
      courierName: ship.courierName,
      isDeliverable: ship.isDeliverable,
      codAvailable: ship.codAvailable !== false,
      mock: ship.mock
    };
  }

  const tax = calculateTax(evaluated.lines);
  const totalAmount = roundMoney2(evaluated.subtotal + deliveryCharges + tax - discount);

  return {
    ...evaluated,
    lines: evaluated.lines,
    discount,
    appliedCouponCode,
    deliveryCharges,
    deliveryMeta,
    tax,
    totalAmount
  };
}

/**
 * Recompute delivery using an existing snapshot weight/dims when pincode matches (TTL handled by caller).
 */
async function refreshDeliveryOnly(postalCode, weightKg, dims, codAmount = 0) {
  return ShiprocketService.checkDeliveryAvailability(postalCode, {
    weightKg,
    lengthCm: dims.lengthCm,
    widthCm: dims.widthCm,
    heightCm: dims.heightCm,
    codAmount
  });
}

module.exports = {
  roundMoney2,
  findVariant,
  getStorefrontSpecificPrice,
  couponUserEligible,
  cartFingerprintFromItems,
  evaluateCartForCheckout,
  resolveCouponDiscount,
  computeCheckoutTotals,
  calculateTax,
  aggregateShipping,
  refreshDeliveryOnly
};
