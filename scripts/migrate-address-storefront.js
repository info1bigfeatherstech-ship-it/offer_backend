/**
 * One-time / ops: backfill Address.storefront = ecomm for legacy docs.
 *
 * Usage (from backend/):
 *   node scripts/migrate-address-storefront.js
 *
 * Safe to re-run. Does not delete addresses.
 */
require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  const uri = process.env.MONGO_DB_URI || process.env.MONGO_DB_URI;
  if (!uri) {
    throw new Error('MONGO_DB_URI / MONGO_DB_URI required');
  }

  await mongoose.connect(uri);
  const col = mongoose.connection.collection('addresses');

  const backfill = await col.updateMany(
    {
      $or: [{ storefront: { $exists: false } }, { storefront: null }, { storefront: '' }]
    },
    { $set: { storefront: 'ecomm' } }
  );
  console.log('[migrate-address-storefront] backfill ecomm:', backfill.modifiedCount);

  try {
    await col.createIndex({ userId: 1, storefront: 1, isDefault: 1 });
    console.log('[migrate-address-storefront] ensured userId+storefront+isDefault index');
  } catch (err) {
    console.warn('[migrate-address-storefront] createIndex:', err.message);
  }

  await mongoose.disconnect();
  console.log('[migrate-address-storefront] done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
