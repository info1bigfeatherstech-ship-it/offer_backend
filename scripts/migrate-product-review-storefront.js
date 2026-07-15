/**
 * One-time / ops: backfill ProductReview.storefront + drop legacy unique index.
 *
 * Usage (from backend/):
 *   node scripts/migrate-product-review-storefront.js
 *
 * Safe to re-run. Does not delete reviews.
 */
require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  const uri = process.env.MONGO_DB_URI || process.env.MONGO_DB_URI;
  if (!uri) {
    throw new Error('MONGO_DB_URI / MONGO_DB_URI required');
  }

  await mongoose.connect(uri);
  const col = mongoose.connection.collection('productreviews');

  const backfill = await col.updateMany(
    {
      $or: [{ storefront: { $exists: false } }, { storefront: null }, { storefront: '' }]
    },
    { $set: { storefront: 'ecomm' } }
  );
  console.log('[migrate-product-review-storefront] backfill ecomm:', backfill.modifiedCount);

  const indexes = await col.indexes();
  for (const idx of indexes) {
    const key = idx.key || {};
    const keyNames = Object.keys(key);
    // Legacy unique: productId + userId only (no storefront)
    if (
      idx.unique &&
      keyNames.length === 2 &&
      key.productId === 1 &&
      key.userId === 1 &&
      key.storefront == null
    ) {
      console.log('[migrate-product-review-storefront] dropping legacy index', idx.name);
      await col.dropIndex(idx.name);
    }
  }

  // Ensure new unique index exists (mongoose syncIndexes also does this on next deploy if enabled)
  try {
    await col.createIndex(
      { productId: 1, userId: 1, storefront: 1 },
      {
        unique: true,
        name: 'uniq_customer_review_per_product_storefront',
        partialFilterExpression: { source: 'customer', userId: { $type: 'objectId' } }
      }
    );
    console.log('[migrate-product-review-storefront] ensured new unique index');
  } catch (err) {
    console.warn('[migrate-product-review-storefront] createIndex:', err.message);
  }

  await mongoose.disconnect();
  console.log('[migrate-product-review-storefront] done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
