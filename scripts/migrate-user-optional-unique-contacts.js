/**
 * Fix phone-only registration E11000 on email_1 (null duplicate).
 *
 * What it does (idempotent / safe to re-run):
 * 1. $unset email / phone / googleId when null or empty string
 * 2. Drop legacy unique indexes that index null (email_1, phone_1, googleId_1, sparse unique)
 * 3. Create partial unique indexes that only cover non-empty strings
 *
 * Usage (from backend/):
 *   node scripts/migrate-user-optional-unique-contacts.js
 *
 * Optional:
 *   MONGODB_DB_NAME=owb   # if URI has no db path (otherwise driver may use "test")
 *
 * Does NOT delete users. Does NOT change passwords or verified flags.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const EMAIL_PARTIAL = 'email_unique_partial';
const PHONE_PARTIAL = 'phone_unique_partial';
const GOOGLE_PARTIAL = 'googleId_unique_partial';

const PARTIAL_SPEC = {
  email: {
    name: EMAIL_PARTIAL,
    key: { email: 1 },
    partialFilterExpression: { email: { $type: 'string', $gt: '' } }
  },
  phone: {
    name: PHONE_PARTIAL,
    key: { phone: 1 },
    partialFilterExpression: { phone: { $type: 'string', $gt: '' } }
  },
  googleId: {
    name: GOOGLE_PARTIAL,
    key: { googleId: 1 },
    partialFilterExpression: { googleId: { $type: 'string', $gt: '' } }
  }
};

function isLegacyUniqueSingleFieldIndex(idx, field) {
  const key = idx.key || {};
  const keys = Object.keys(key);
  if (keys.length !== 1 || key[field] !== 1) return false;
  if (!idx.unique) return false;
  // Keep our partial indexes
  if (idx.name === PARTIAL_SPEC[field].name) return false;
  // Drop classic email_1 / sparse unique / any other unique on this field alone
  return true;
}

async function findDuplicateValues(col, field) {
  return col
    .aggregate([
      { $match: { [field]: { $type: 'string', $gt: '' } } },
      { $group: { _id: `$${field}`, n: { $sum: 1 }, ids: { $push: '$_id' } } },
      { $match: { n: { $gt: 1 } } }
    ])
    .toArray();
}

async function ensurePartialUnique(col, field) {
  const spec = PARTIAL_SPEC[field];
  const indexes = await col.indexes();
  const existing = indexes.find((i) => i.name === spec.name);
  if (existing) {
    console.log(`[migrate-user-contacts] index ok: ${spec.name}`);
    return { ok: true, skipped: false };
  }

  const dups = await findDuplicateValues(col, field);
  if (dups.length) {
    console.warn(
      `[migrate-user-contacts] SKIP creating ${spec.name} — ${dups.length} duplicate ${field} value(s). Resolve duplicates then re-run.`
    );
    for (const d of dups.slice(0, 20)) {
      console.warn(`  ${field}=${d._id} count=${d.n}`);
    }
    // Ensure query performance if no index remains on this field.
    const afterDrop = await col.indexes();
    const hasAnyFieldIndex = afterDrop.some((i) => {
      const keys = Object.keys(i.key || {});
      return keys.length === 1 && i.key[field] === 1;
    });
    if (!hasAnyFieldIndex) {
      const fallback = `${field}_1`;
      console.warn(`[migrate-user-contacts] creating non-unique fallback ${fallback} for lookups`);
      await col.createIndex({ [field]: 1 }, { name: fallback, background: true, sparse: true });
    }
    return { ok: false, skipped: true, dups };
  }

  console.log(`[migrate-user-contacts] creating ${spec.name}`);
  await col.createIndex(spec.key, {
    unique: true,
    name: spec.name,
    partialFilterExpression: spec.partialFilterExpression,
    background: true
  });
  return { ok: true, skipped: false };
}

async function main() {
  const uri = process.env.MONGO_DB_URI;
  if (!uri) throw new Error('MONGO_DB_URI required');

  const dbName = process.env.MONGODB_DB_NAME || process.env.MONGO_DB_NAME || undefined;
  await mongoose.connect(uri, dbName ? { dbName } : undefined);

  const db = mongoose.connection.db;
  console.log(`[migrate-user-contacts] database: ${db.databaseName}`);

  const col = db.collection('users');

  const unsetEmail = await col.updateMany(
    {
      $or: [
        { email: null },
        { email: '' },
        { email: { $exists: true, $not: { $type: 'string' } } },
        { email: { $type: 'string', $eq: '' } }
      ]
    },
    { $unset: { email: 1 } }
  );
  const unsetPhone = await col.updateMany(
    {
      $or: [
        { phone: null },
        { phone: '' },
        { phone: { $exists: true, $not: { $type: 'string' } } },
        { phone: { $type: 'string', $eq: '' } }
      ]
    },
    { $unset: { phone: 1 } }
  );
  const unsetGoogle = await col.updateMany(
    {
      $or: [
        { googleId: null },
        { googleId: '' },
        { googleId: { $exists: true, $not: { $type: 'string' } } },
        { googleId: { $type: 'string', $eq: '' } }
      ]
    },
    { $unset: { googleId: 1 } }
  );
  console.log('[migrate-user-contacts] unset empty email:', unsetEmail.modifiedCount);
  console.log('[migrate-user-contacts] unset empty phone:', unsetPhone.modifiedCount);
  console.log('[migrate-user-contacts] unset empty googleId:', unsetGoogle.modifiedCount);

  const indexes = await col.indexes();
  for (const idx of indexes) {
    for (const field of Object.keys(PARTIAL_SPEC)) {
      if (isLegacyUniqueSingleFieldIndex(idx, field)) {
        console.log(`[migrate-user-contacts] dropping legacy index ${idx.name}`, {
          unique: idx.unique,
          sparse: idx.sparse,
          partial: Boolean(idx.partialFilterExpression)
        });
        await col.dropIndex(idx.name);
      }
    }
  }

  let failed = false;
  for (const field of Object.keys(PARTIAL_SPEC)) {
    const result = await ensurePartialUnique(col, field);
    if (!result.ok) failed = true;
  }

  console.log('[migrate-user-contacts] done. Indexes:', (await col.indexes()).map((i) => i.name));
  await mongoose.disconnect();
  if (failed) {
    console.error(
      '[migrate-user-contacts] completed with warnings — some partial unique indexes were skipped due to duplicate data.'
    );
    process.exit(2);
  }
}

main().catch(async (err) => {
  console.error('[migrate-user-contacts] FAILED:', err.message);
  try {
    await mongoose.disconnect();
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
