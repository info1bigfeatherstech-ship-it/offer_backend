/**
 * Backfill variant SKUs to `SKU-{productCode}` — only where SKU is NOT already
 * derived from productCode (typical: manual single-listing random `SKU-A1B2C3D4`).
 *
 * Does NOT touch variants that already have sku === SKU-{productCode}.
 * Does NOT invent productCodes. Skips collisions / missing codes.
 *
 * Usage (from backend/):
 *   node scripts/migrate-variant-sku-from-product-code.js           # dry-run (default)
 *   node scripts/migrate-variant-sku-from-product-code.js --apply   # write changes
 *
 * Optional env:
 *   MONGODB_DB_NAME=owb
 *   MIGRATE_SKU_APPLY=true   # same as --apply
 *
 * Safe to re-run (idempotent).
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { buildSkuFromProductCode } = require('../utils/productUtils');

function normalizeCode(value) {
  return String(value || '')
    .trim()
    .toUpperCase();
}

function normalizeSku(value) {
  return String(value || '').trim();
}

/** Former random generator: SKU- + 8 hex chars (crypto.randomBytes(4)). */
function looksLikeLegacyRandomSku(sku) {
  return /^SKU-[0-9A-Fa-f]{8}$/.test(String(sku || '').trim());
}

function parseArgs(argv) {
  const apply =
    argv.includes('--apply') ||
    String(process.env.MIGRATE_SKU_APPLY || '').toLowerCase() === 'true';
  /** If true, only rewrite hex-random SKUs (safest). Default true. */
  const onlyRandom =
    !argv.includes('--all-mismatched') &&
    String(process.env.MIGRATE_SKU_ALL_MISMATCHED || '').toLowerCase() !== 'true';
  return { apply, onlyRandom };
}

async function main() {
  const { apply, onlyRandom } = parseArgs(process.argv.slice(2));
  const uri = process.env.MONGO_DB_URI;
  if (!uri) throw new Error('MONGO_DB_URI required');

  const dbName = process.env.MONGODB_DB_NAME || process.env.MONGO_DB_NAME || undefined;
  await mongoose.connect(uri, dbName ? { dbName } : undefined);

  const db = mongoose.connection.db;
  const col = db.collection('products');
  console.log(`[migrate-sku] database: ${db.databaseName}`);
  console.log(`[migrate-sku] mode: ${apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(
    `[migrate-sku] scope: ${
      onlyRandom
        ? 'legacy random SKU-XXXXXXXX only (use --all-mismatched to widen)'
        : 'any SKU that is not SKU-{productCode}'
    }`
  );

  const cursor = col.find(
    { 'variants.0': { $exists: true } },
    { projection: { name: 1, slug: 1, variants: 1 } }
  );

  const planned = [];
  const skipped = {
    alreadyCanonical: 0,
    noProductCode: 0,
    notInScope: 0,
    targetCollision: 0,
    invalid: 0
  };

  /** Target SKUs claimed in this run (avoid two variants claiming same SKU). */
  const reservedTargets = new Set();

  // Preload all existing SKUs for collision checks
  const existingSkuOwners = new Map(); // sku -> `${productId}:${variantId}`
  const allForSku = col.find(
    { 'variants.sku': { $exists: true, $type: 'string', $ne: '' } },
    { projection: { 'variants.sku': 1, 'variants._id': 1 } }
  );
  for await (const doc of allForSku) {
    for (const v of doc.variants || []) {
      const s = normalizeSku(v.sku);
      if (!s || !v._id) continue;
      existingSkuOwners.set(s, `${doc._id}:${v._id}`);
    }
  }

  for await (const product of cursor) {
    for (const variant of product.variants || []) {
      const code = normalizeCode(variant.productCode);
      const currentSku = normalizeSku(variant.sku);

      if (!code) {
        skipped.noProductCode += 1;
        continue;
      }

      let expectedSku;
      try {
        expectedSku = buildSkuFromProductCode(code);
      } catch {
        skipped.invalid += 1;
        continue;
      }

      if (currentSku === expectedSku) {
        skipped.alreadyCanonical += 1;
        continue;
      }

      if (onlyRandom && !looksLikeLegacyRandomSku(currentSku)) {
        // e.g. custom CSV sku, slug-DEFAULT, etc. — leave alone unless --all-mismatched
        skipped.notInScope += 1;
        continue;
      }

      const owner = existingSkuOwners.get(expectedSku);
      const selfKey = `${product._id}:${variant._id}`;
      if (owner && owner !== selfKey) {
        skipped.targetCollision += 1;
        console.warn(
          `[migrate-sku] SKIP collision productCode=${code} want=${expectedSku} heldBy=${owner} current=${currentSku}`
        );
        continue;
      }
      if (reservedTargets.has(expectedSku) && owner !== selfKey) {
        skipped.targetCollision += 1;
        continue;
      }

      reservedTargets.add(expectedSku);
      planned.push({
        productId: product._id,
        slug: product.slug,
        variantId: variant._id,
        productCode: code,
        fromSku: currentSku || '(empty)',
        toSku: expectedSku
      });
    }
  }

  console.log(`[migrate-sku] would update: ${planned.length}`);
  console.log('[migrate-sku] skipped:', skipped);
  for (const row of planned.slice(0, 40)) {
    console.log(
      `  ${row.slug || row.productId} | ${row.productCode} | ${row.fromSku} → ${row.toSku}`
    );
  }
  if (planned.length > 40) {
    console.log(`  ... and ${planned.length - 40} more`);
  }

  if (!apply) {
    console.log('[migrate-sku] dry-run only. Re-run with --apply to write.');
    await mongoose.disconnect();
    return;
  }

  let updated = 0;
  let failed = 0;
  for (const row of planned) {
    try {
      const result = await col.updateOne(
        { _id: row.productId, 'variants._id': row.variantId },
        { $set: { 'variants.$.sku': row.toSku, updatedAt: new Date() } }
      );
      if (result.modifiedCount === 1 || result.matchedCount === 1) {
        // matchedCount 1 with modified 0 can mean already set (race) — count as ok if sku now expected
        if (result.modifiedCount === 1) updated += 1;
        else {
          const check = await col.findOne(
            { _id: row.productId, 'variants._id': row.variantId },
            { projection: { 'variants.$': 1 } }
          );
          const nowSku = normalizeSku(check?.variants?.[0]?.sku);
          if (nowSku === row.toSku) updated += 1;
          else {
            failed += 1;
            console.warn('[migrate-sku] no modify', row);
          }
        }
        existingSkuOwners.delete(row.fromSku === '(empty)' ? '' : row.fromSku);
        existingSkuOwners.set(row.toSku, `${row.productId}:${row.variantId}`);
      } else {
        failed += 1;
        console.warn('[migrate-sku] variant not found', row);
      }
    } catch (err) {
      failed += 1;
      console.error('[migrate-sku] update failed', row.toSku, err.message);
    }
  }

  console.log(`[migrate-sku] updated=${updated} failed=${failed}`);
  await mongoose.disconnect();
  if (failed) process.exit(2);
}

main().catch(async (err) => {
  console.error('[migrate-sku] FAILED:', err.message);
  try {
    await mongoose.disconnect();
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
