/**
 * Verified-purchase helpers for customer product reviews.
 * Logged-in customers may review anytime; a delivered order unlocks Verified purchase.
 */
const mongoose = require('mongoose');
const Order = require('../models/Order');
const ProductReview = require('../models/ProductReview');

/** Orders that prove the customer received the product. */
const REVIEWABLE_ORDER_STATUSES = Object.freeze(['delivered', 'return_requested']);

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(String(id || ''));
}

function toObjectId(id) {
  if (!isValidObjectId(id)) return null;
  return new mongoose.Types.ObjectId(String(id));
}

/**
 * @param {string|import('mongoose').Types.ObjectId} userId
 * @param {string|import('mongoose').Types.ObjectId} productId
 * @param {{ orderId?: string|null }} [opts]
 * @returns {Promise<{ eligible: boolean, order: object|null, code?: string, message?: string }>}
 */
async function findDeliveredPurchaseForProduct(userId, productId, opts = {}) {
  const uid = toObjectId(userId);
  const pid = toObjectId(productId);
  if (!uid || !pid) {
    return {
      eligible: false,
      order: null,
      code: 'INVALID_IDS',
      message: 'Invalid user or product id',
    };
  }

  const filter = {
    userId: uid,
    orderStatus: { $in: [...REVIEWABLE_ORDER_STATUSES] },
    'items.productId': pid,
  };

  const orderIdRaw = String(opts.orderId || '').trim();
  if (orderIdRaw) {
    filter.orderId = orderIdRaw;
  }

  const order = await Order.findOne(filter)
    .sort({ 'shipmentInfo.deliveredAt': -1, updatedAt: -1 })
    .select('orderId orderStatus items.productId items.variantId shipmentInfo.deliveredAt')
    .lean();

  if (!order) {
    return {
      eligible: false,
      order: null,
      code: orderIdRaw ? 'ORDER_NOT_ELIGIBLE' : 'NO_DELIVERED_PURCHASE',
      message: orderIdRaw
        ? 'This order is not eligible for review (must be delivered and contain this product).'
        : 'You can review this product after an order containing it has been delivered.',
    };
  }

  return { eligible: true, order };
}

/**
 * @param {string|import('mongoose').Types.ObjectId} userId
 * @param {string|import('mongoose').Types.ObjectId} productId
 */
async function getProductReviewEligibility(userId, productId) {
  const uid = toObjectId(userId);
  const pid = toObjectId(productId);
  if (!uid || !pid) {
    return {
      canCreate: false,
      hasReview: false,
      review: null,
      qualifyingOrderId: null,
      verifiedPurchaseEligible: false,
      canAttachImages: false,
      code: 'INVALID_IDS',
      message: 'Invalid user or product id',
    };
  }

  const existing = await ProductReview.findOne({
    productId: pid,
    userId: uid,
    source: 'customer',
  })
    .select('_id rating comment isActive verifiedPurchase orderId images createdAt updatedAt')
    .lean();

  if (existing) {
    return {
      canCreate: false,
      canUpdate: true,
      hasReview: true,
      review: existing,
      qualifyingOrderId: existing.orderId || null,
      verifiedPurchaseEligible: Boolean(existing.verifiedPurchase),
      canAttachImages: Boolean(existing.verifiedPurchase),
      code: 'ALREADY_REVIEWED',
      message: 'You have already reviewed this product. You can update your review.',
    };
  }

  const purchase = await findDeliveredPurchaseForProduct(uid, pid);
  const verifiedPurchaseEligible = Boolean(purchase.eligible);
  // Any logged-in customer can write a review; delivered order only adds Verified purchase + photos.
  return {
    canCreate: true,
    canUpdate: false,
    hasReview: false,
    review: null,
    qualifyingOrderId: verifiedPurchaseEligible ? purchase.order?.orderId || null : null,
    verifiedPurchaseEligible,
    canAttachImages: verifiedPurchaseEligible,
    code: 'ELIGIBLE',
    message: 'You can write a review for this product.',
  };
}

/**
 * Per-line review status for a delivered order (My Orders UI).
 * @param {string|import('mongoose').Types.ObjectId} userId
 * @param {string} orderId
 */
async function getOrderReviewableItems(userId, orderId) {
  const uid = toObjectId(userId);
  const oid = String(orderId || '').trim();
  if (!uid || !oid) {
    return {
      eligible: false,
      orderStatus: null,
      items: [],
      code: 'INVALID_IDS',
      message: 'Invalid user or order id',
    };
  }

  const order = await Order.findOne({ orderId: oid, userId: uid })
    .select('orderId orderStatus items.productId items.variantId items.quantity')
    .populate('items.productId', 'name slug')
    .lean();

  if (!order) {
    return {
      eligible: false,
      orderStatus: null,
      items: [],
      code: 'ORDER_NOT_FOUND',
      message: 'Order not found',
    };
  }

  const status = String(order.orderStatus || '').toLowerCase();
  const orderEligible = REVIEWABLE_ORDER_STATUSES.includes(status);

  const productIds = (order.items || [])
    .map((it) => it.productId?._id || it.productId)
    .filter(Boolean)
    .map((id) => String(id));

  const uniqueProductIds = [...new Set(productIds)].filter((id) => isValidObjectId(id));

  const existingReviews = uniqueProductIds.length
    ? await ProductReview.find({
        userId: uid,
        source: 'customer',
        productId: { $in: uniqueProductIds.map((id) => toObjectId(id)) },
      })
        .select('_id productId')
        .lean()
    : [];

  const reviewByProduct = new Map(
    existingReviews.map((r) => [String(r.productId), String(r._id)])
  );

  const items = (order.items || []).map((it) => {
    const product = it.productId && typeof it.productId === 'object' ? it.productId : null;
    const productId = product?._id || it.productId;
    const pidStr = productId ? String(productId) : null;
    const reviewId = pidStr ? reviewByProduct.get(pidStr) || null : null;
    return {
      productId: pidStr,
      variantId: it.variantId ? String(it.variantId) : null,
      quantity: it.quantity,
      productName: product?.name || product?.title || 'Product',
      productSlug: product?.slug || null,
      alreadyReviewed: Boolean(reviewId),
      reviewId,
      canReview: Boolean(orderEligible && pidStr && !reviewId),
    };
  });

  return {
    eligible: orderEligible,
    orderStatus: status,
    orderId: order.orderId,
    items,
    code: orderEligible ? 'OK' : 'ORDER_NOT_DELIVERED',
    message: orderEligible
      ? 'Order is eligible for product reviews'
      : 'Reviews unlock after this order is delivered',
  };
}

module.exports = {
  REVIEWABLE_ORDER_STATUSES,
  findDeliveredPurchaseForProduct,
  getProductReviewEligibility,
  getOrderReviewableItems,
};
