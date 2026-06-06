/**
 * Unit tests — product catalog reconcile.
 * Run: node scripts/test-storefront-catalog-reconcile.js
 */
const assert = require('assert');
const {
  reconcileProductCatalogState,
  deriveProductChannelStatusFromVariants,
  effectiveVariantChannelStatus
} = require('../utils/storefrontCatalog');

function testDraftVariantStaysInactive() {
  const product = {
    status: 'draft',
    channelStatus: { ecomm: 'draft', wholesale: 'draft' },
    variants: [
      {
        productCode: 'SKU-1',
        isActive: false,
        channelVisibility: { ecomm: 'draft', wholesale: 'draft' },
        wholesale: false,
        price: { base: 100 }
      }
    ]
  };
  reconcileProductCatalogState(product);
  assert.strictEqual(product.status, 'draft');
  assert.strictEqual(product.channelStatus.ecomm, 'draft');
  assert.strictEqual(product.variants[0].isActive, false);
}

function testActivateEcommSyncsLegacyFlags() {
  const product = {
    status: 'draft',
    channelStatus: { ecomm: 'draft', wholesale: 'draft' },
    variants: [
      {
        productCode: 'SKU-1',
        isActive: false,
        channelVisibility: { ecomm: 'active', wholesale: 'draft' },
        wholesale: false,
        price: { base: 199, sale: 99 }
      }
    ]
  };
  reconcileProductCatalogState(product);
  assert.strictEqual(product.variants[0].isActive, true);
  assert.strictEqual(product.status, 'active');
  assert.strictEqual(product.channelStatus.ecomm, 'active');
}

function testDeriveFromMixedVariants() {
  const derived = deriveProductChannelStatusFromVariants([
    { channelVisibility: { ecomm: 'draft' }, isActive: false },
    { channelVisibility: { ecomm: 'active' }, isActive: true }
  ]);
  assert.strictEqual(derived.ecomm, 'active');
}

function testEffectiveVariantUsesChannelVisibility() {
  const st = effectiveVariantChannelStatus(
    { isActive: false, channelVisibility: { ecomm: 'active' } },
    'ecomm'
  );
  assert.strictEqual(st, 'active');
}

function run() {
  testDraftVariantStaysInactive();
  testActivateEcommSyncsLegacyFlags();
  testDeriveFromMixedVariants();
  testEffectiveVariantUsesChannelVisibility();
  console.log('test-storefront-catalog-reconcile: all passed');
}

run();
