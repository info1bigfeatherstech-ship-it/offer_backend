const mongoose = require('mongoose');
const Product = require('../models/Product');
const ProductReview = require('../models/ProductReview');
const cacheService = require('./cache.service');
const cacheConfig = require('../config/cache.config');
const { buildReviewStorefrontMatch } = require('../utils/reviewStorefrontScope');

async function invalidateProductCaches() {
  try {
    await cacheService.forget(`${cacheConfig.prefixes.PRODUCT}:*`);
    await cacheService.forget(`${cacheConfig.prefixes.SEARCH}:*`);
  } catch (err) {
    console.error('[productReviewSync] cache invalidate:', err?.message || err);
  }
}

function roundAvg(sum, count) {
  if (!count) return null;
  return Math.round((sum / count) * 10) / 10;
}

/**
 * Aggregate active reviews for a product (optionally scoped to one storefront).
 * @param {string|mongoose.Types.ObjectId} productId
 * @param {'ecomm'|'wholesale'|null} [storefront]
 * @returns {Promise<{ averageRating: number|null, reviewCount: number }>}
 */
async function aggregateActiveReviewSummary(productId, storefront = null) {
  const pid =
    typeof productId === 'string' ? new mongoose.Types.ObjectId(productId) : productId;

  const match = { productId: pid, isActive: true };
  const scoped =
    storefront != null
      ? { $and: [match, buildReviewStorefrontMatch(storefront)] }
      : match;

  const agg = await ProductReview.aggregate([
    { $match: scoped },
    { $group: { _id: null, count: { $sum: 1 }, sum: { $sum: '$rating' } } }
  ]);

  const count = agg[0]?.count || 0;
  const sum = agg[0]?.sum || 0;
  return {
    averageRating: roundAvg(sum, count),
    reviewCount: count
  };
}

/**
 * Recomputes Product.rating from **ecomm** active reviews (legacy cards / ecomm lists).
 * Wholesale PDP uses public summary API filtered by storefront instead.
 * @param {string|mongoose.Types.ObjectId} productId
 */
async function syncProductRatingFromReviews(productId) {
  const pid =
    typeof productId === 'string' ? new mongoose.Types.ObjectId(productId) : productId;

  const { averageRating: value, reviewCount: count } = await aggregateActiveReviewSummary(
    pid,
    'ecomm'
  );

  await Product.updateOne(
    { _id: pid },
    { $set: { rating: { value, count } } }
  );

  await invalidateProductCaches();
}

module.exports = {
  syncProductRatingFromReviews,
  aggregateActiveReviewSummary,
  invalidateProductCaches
};
