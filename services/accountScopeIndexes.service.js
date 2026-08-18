/**
 * Production-safe index migration for per-storefront customer identity.
 *
 * Order matters:
 *  1. Backfill accountScope
 *  2. Create compound unique indexes (email/phone/googleId + accountScope)
 *  3. Drop legacy global unique indexes
 *
 * Idempotent. Safe to run on every boot (short).
 */

const logger = require('../utils/logger');
const { deriveAccountScope, ACCOUNT_SCOPES } = require('../utils/accountScope');

const LEGACY_UNIQUE_INDEX_NAMES = new Set([
  'email_unique_partial',
  'phone_unique_partial',
  'googleId_unique_partial',
  'email_1',
  'phone_1',
  'googleId_1'
]);

const COMPOUND_INDEXES = [
  {
    name: 'email_accountScope_unique_partial',
    key: { email: 1, accountScope: 1 },
    options: {
      unique: true,
      name: 'email_accountScope_unique_partial',
      partialFilterExpression: {
        email: { $type: 'string', $gt: '' },
        accountScope: { $type: 'string', $gt: '' }
      },
      background: true
    }
  },
  {
    name: 'phone_accountScope_unique_partial',
    key: { phone: 1, accountScope: 1 },
    options: {
      unique: true,
      name: 'phone_accountScope_unique_partial',
      partialFilterExpression: {
        phone: { $type: 'string', $gt: '' },
        accountScope: { $type: 'string', $gt: '' }
      },
      background: true
    }
  },
  {
    name: 'googleId_accountScope_unique_partial',
    key: { googleId: 1, accountScope: 1 },
    options: {
      unique: true,
      name: 'googleId_accountScope_unique_partial',
      partialFilterExpression: {
        googleId: { $type: 'string', $gt: '' },
        accountScope: { $type: 'string', $gt: '' }
      },
      background: true
    }
  }
];

function isLegacyGlobalUniqueContactIndex(idx) {
  if (!idx?.unique) return false;
  if (LEGACY_UNIQUE_INDEX_NAMES.has(idx.name)) {
    const keys = Object.keys(idx.key || {});
    return keys.length === 1 && ['email', 'phone', 'googleId'].includes(keys[0]);
  }
  const keys = Object.keys(idx.key || {});
  return keys.length === 1 && ['email', 'phone', 'googleId'].includes(keys[0]) && idx.unique;
}

async function backfillAccountScope(col) {
  const cursor = col.find(
    { $or: [{ accountScope: { $exists: false } }, { accountScope: null }, { accountScope: '' }] },
    { projection: { userType: 1, role: 1, accountScope: 1 } }
  );

  let updated = 0;
  const ops = [];
  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    const scope = deriveAccountScope(doc) || ACCOUNT_SCOPES.ECOMM;
    ops.push({
      updateOne: {
        filter: { _id: doc._id },
        update: { $set: { accountScope: scope } }
      }
    });
    if (ops.length >= 500) {
      const res = await col.bulkWrite(ops, { ordered: false });
      updated += res.modifiedCount || 0;
      ops.length = 0;
    }
  }
  if (ops.length) {
    const res = await col.bulkWrite(ops, { ordered: false });
    updated += res.modifiedCount || 0;
  }
  return updated;
}

async function ensureCompoundIndexes(col) {
  const existing = await col.indexes();
  const byName = new Map(existing.map((i) => [i.name, i]));
  for (const spec of COMPOUND_INDEXES) {
    if (byName.has(spec.name)) continue;
    await col.createIndex(spec.key, spec.options);
    logger.info('[accountScopeIndexes] created index', { name: spec.name });
  }
}

async function dropLegacyGlobalUniqueIndexes(col) {
  const existing = await col.indexes();
  const leftover = [];
  for (const idx of existing) {
    if (!isLegacyGlobalUniqueContactIndex(idx)) continue;
    try {
      await col.dropIndex(idx.name);
      logger.info('[accountScopeIndexes] dropped legacy unique index', { name: idx.name });
    } catch (err) {
      leftover.push(idx.name);
      logger.warn('[accountScopeIndexes] could not drop index', {
        name: idx.name,
        message: err?.message
      });
    }
  }
  const after = await col.indexes();
  for (const idx of after) {
    if (isLegacyGlobalUniqueContactIndex(idx)) leftover.push(idx.name);
  }
  if (leftover.length) {
    const err = new Error(
      `Legacy global unique contact indexes still present (${[...new Set(leftover)].join(', ')}). Same email/phone cannot exist on ecomm+wholesale until these are dropped.`
    );
    err.code = 'LEGACY_UNIQUE_INDEX_REMAINS';
    throw err;
  }
}

async function ensureAccountScopeIndexes(mongooseConnection) {
  const db = mongooseConnection?.connection?.db;
  if (!db) {
    throw new Error('MongoDB connection is not ready for account-scope index migration');
  }
  const col = db.collection('users');

  const backfilled = await backfillAccountScope(col);
  if (backfilled) {
    logger.info('[accountScopeIndexes] backfilled accountScope', { updated: backfilled });
  }

  await ensureCompoundIndexes(col);
  await dropLegacyGlobalUniqueIndexes(col);
}

module.exports = {
  ensureAccountScopeIndexes,
  COMPOUND_INDEXES
};
