const mongoose = require('mongoose');
const Product = require('../models/Product');
const ProductReview = require('../models/ProductReview');
const cacheService = require('./cache.service');
const cacheConfig = require('../config/cache.config');

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
 * Recomputes aggregate rating on Product from active reviews and busts list/detail cache.
 * @param {string|mongoose.Types.ObjectId} productId
 */
async function syncProductRatingFromReviews(productId) {
  const pid =
    typeof productId === 'string' ? new mongoose.Types.ObjectId(productId) : productId;

  const agg = await ProductReview.aggregate([
    { $match: { productId: pid, isActive: true } },
    { $group: { _id: null, count: { $sum: 1 }, sum: { $sum: '$rating' } } }
  ]);

  const count = agg[0]?.count || 0;
  const sum = agg[0]?.sum || 0;
  const value = roundAvg(sum, count);

  await Product.updateOne(
    { _id: pid },
    { $set: { rating: { value, count } } }
  );

  await invalidateProductCaches();
}

module.exports = {
  syncProductRatingFromReviews,
  invalidateProductCaches
};
