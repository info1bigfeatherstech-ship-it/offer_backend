/**
 * One-time / maintenance: align variant channelVisibility, isActive, and product status fields.
 * Run: node scripts/reconcile-product-catalog-state.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const Product = require('../models/Product');
const { reconcileProductCatalogState } = require('../utils/storefrontCatalog');
const { LifecycleExpiration$ } = require('@aws-sdk/client-s3');

async function main() {
  const uri = process.env.MONGO_DB_URI || process.env.MONGO_DB_URI;
  if (!uri) {
    console.error('MONGO_DB_URI not set');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('Connected. Reconciling product catalog state…');

  const cursor = Product.find({}).cursor();
  let scanned = 0;
  let updated = 0;

  for await (const doc of cursor) {
    scanned += 1;
    const before = JSON.stringify({
      status: doc.status,
      channelStatus: doc.channelStatus,
      variants: (doc.variants || []).map((v) => ({
        productCode: v.productCode,
        isActive: v.isActive,
        ecomm: v.channelVisibility?.ecomm
      }))
    });

    reconcileProductCatalogState(doc);

    const after = JSON.stringify({
      status: doc.status,
      channelStatus: doc.channelStatus,
      variants: (doc.variants || []).map((v) => ({
        productCode: v.productCode,
        isActive: v.isActive,
        ecomm: v.channelVisibility?.ecomm
      }))
    });

    if (before !== after) {
      await doc.save({ validateBeforeSave: true });
      updated += 1;
      console.log(`Updated: ${doc.slug}`);
    }
  }

  console.log(`Done. Scanned ${scanned}, updated ${updated}.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
