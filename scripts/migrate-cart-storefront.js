/**
 * One-time / ops: backfill Cart.storefront + replace unique(userId) with unique(userId, storefront).
 *
 * Usage (from backend/):
 *   node scripts/migrate-cart-storefront.js
 *
 * Safe to re-run. Does not delete carts.
 * Run before / with deploy so wholesale can create a second cart per user.
 */
require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  const uri = process.env.MONGO_DB_URI || process.env.MONGO_DB_URI;
  if (!uri) {
    throw new Error('MONGO_DB_URI / MONGO_DB_URI required');
  }

  await mongoose.connect(uri);
  const col = mongoose.connection.collection('carts');

  const backfill = await col.updateMany(
    {
      $or: [{ storefront: { $exists: false } }, { storefront: null }, { storefront: '' }]
    },
    { $set: { storefront: 'ecomm' } }
  );
  console.log('[migrate-cart-storefront] backfill ecomm:', backfill.modifiedCount);

  const indexes = await col.indexes();
  for (const idx of indexes) {
    const key = idx.key || {};
    const keyNames = Object.keys(key);
    // Legacy unique: userId only
    if (idx.unique && keyNames.length === 1 && key.userId === 1 && key.storefront == null) {
      console.log('[migrate-cart-storefront] dropping legacy index', idx.name);
      await col.dropIndex(idx.name);
    }
  }

  try {
    await col.createIndex(
      { userId: 1, storefront: 1 },
      { unique: true, name: 'uniq_cart_per_user_storefront' }
    );
    console.log('[migrate-cart-storefront] ensured new unique index');
  } catch (err) {
    console.warn('[migrate-cart-storefront] createIndex:', err.message);
  }

  await mongoose.disconnect();
  console.log('[migrate-cart-storefront] done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
