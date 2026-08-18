/**
 * Ensure per-storefront customer identity indexes.
 *
 * Run from backend/:
 *   node scripts/migrate-account-scope-identity.js
 *
 * Also runs automatically on server boot via database.config.js.
 *
 * Hijacked-account report (wholesaler with ecomm carts/orders):
 *   node scripts/migrate-account-scope-identity.js --report
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { ensureAccountScopeIndexes } = require('../services/accountScopeIndexes.service');
const { ensurePerStorefrontIndexes } = require('../services/shippingProviderSettings.service');

async function reportHijackedAccounts(db) {
  const users = db.collection('users');
  const carts = db.collection('carts');
  const orders = db.collection('orders');

  const wholesalers = await users
    .find({
      $or: [{ accountScope: 'wholesale' }, { userType: 'wholesaler' }, { role: 'wholesaler' }]
    })
    .project({ email: 1, phone: 1, userType: 1, accountScope: 1, name: 1 })
    .toArray();

  console.log(`[report] wholesaler accounts: ${wholesalers.length}`);
  let flagged = 0;
  for (const u of wholesalers) {
    const ecommCart = await carts.findOne({
      userId: u._id,
      $or: [{ storefront: 'ecomm' }, { storefront: { $exists: false } }, { storefront: null }]
    });
    const ecommOrder = await orders.findOne({
      userId: u._id,
      $or: [{ storefront: 'ecomm' }, { storefront: { $exists: false } }, { storefront: null }]
    });
    if (!ecommCart && !ecommOrder) continue;
    flagged += 1;
    console.log('[report] possible hijack / mixed history', {
      userId: String(u._id),
      email: u.email || null,
      phone: u.phone || null,
      accountScope: u.accountScope || null,
      hasEcommCart: Boolean(ecommCart),
      hasEcommOrder: Boolean(ecommOrder)
    });
  }
  console.log(`[report] flagged: ${flagged}. These ecomm carts/orders stay on the wholesaler userId.`);
  console.log('[report] Customer can register a NEW ecomm account with the same email/phone after this deploy.');
}

async function main() {
  const uri = process.env.MONGO_DB_URI;
  if (!uri) throw new Error('MONGO_DB_URI required');
  const dbName = process.env.MONGODB_DB_NAME || process.env.MONGO_DB_NAME || undefined;
  await mongoose.connect(uri, dbName ? { dbName } : undefined);

  await ensureAccountScopeIndexes(mongoose);
  await ensurePerStorefrontIndexes(mongoose);
  console.log('[migrate-account-scope] indexes ready');

  if (process.argv.includes('--report')) {
    await reportHijackedAccounts(mongoose.connection.db);
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('[migrate-account-scope] FAILED:', err.message);
  try {
    await mongoose.disconnect();
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
