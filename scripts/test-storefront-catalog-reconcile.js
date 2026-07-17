/**
 * Unit tests — product catalog reconcile.
 * Run: node scripts/test-storefront-catalog-reconcile.js
 */
const assert = require('assert');
const {
  reconcileProductCatalogState,
  deriveProductChannelStatusFromVariants,
  effectiveVariantChannelStatus,
  hasWholesalePricingEligibleVariant,
  hasActiveWholesaleVariantForCatalog
} = require('../utils/storefrontCatalog');

function pricedWholesaleVariant(visibility) {
  return {
    productCode: 'WS-1',
    isActive: visibility === 'active',
    channelVisibility: { ecomm: 'draft', wholesale: visibility },
    wholesale: true,
    price: { base: 100, wholesaleBase: 80 }
  };
}

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

/** Pricing present + wholesale visibility draft → product wholesale = draft (not active). */
function testWholesalePricingWithDraftVisibilityStaysDraft() {
  const derived = deriveProductChannelStatusFromVariants([
    pricedWholesaleVariant('draft')
  ]);
  assert.strictEqual(derived.wholesale, 'draft');
  assert.strictEqual(derived.ecomm, 'draft');

  const product = {
    status: 'draft',
    channelStatus: { ecomm: 'draft', wholesale: 'active' },
    variants: [pricedWholesaleVariant('draft')]
  };
  reconcileProductCatalogState(product);
  assert.strictEqual(
    product.channelStatus.wholesale,
    'draft',
    'reconcile must not force wholesale active from pricing alone'
  );
}

/** Pricing + active visibility → wholesale active. */
function testWholesalePricingWithActiveVisibilityIsActive() {
  const derived = deriveProductChannelStatusFromVariants([
    pricedWholesaleVariant('active')
  ]);
  assert.strictEqual(derived.wholesale, 'active');
}

/** No wholesale pricing → never active even if visibility says active. */
function testWholesaleWithoutPricingNeverActive() {
  const derived = deriveProductChannelStatusFromVariants([
    {
      channelVisibility: { ecomm: 'draft', wholesale: 'active' },
      isActive: true,
      wholesale: false,
      price: { base: 50 }
    }
  ]);
  assert.strictEqual(derived.wholesale, 'draft');
}

/** Eligibility helpers: pricing-only vs listed. */
function testWholesaleEligibilityHelpers() {
  const draftPriced = { variants: [pricedWholesaleVariant('draft')] };
  assert.strictEqual(hasWholesalePricingEligibleVariant(draftPriced), true);
  assert.strictEqual(hasActiveWholesaleVariantForCatalog(draftPriced), false);

  const activePriced = { variants: [pricedWholesaleVariant('active')] };
  assert.strictEqual(hasWholesalePricingEligibleVariant(activePriced), true);
  assert.strictEqual(hasActiveWholesaleVariantForCatalog(activePriced), true);

  const noPricing = {
    variants: [
      {
        channelVisibility: { wholesale: 'active' },
        wholesale: false,
        price: { base: 10 }
      }
    ]
  };
  assert.strictEqual(hasWholesalePricingEligibleVariant(noPricing), false);
  assert.strictEqual(hasActiveWholesaleVariantForCatalog(noPricing), false);
}

/** Ecomm derive unchanged when wholesale variants mix in. */
function testEcommUnaffectedByWholesalePricing() {
  const derived = deriveProductChannelStatusFromVariants([
    {
      channelVisibility: { ecomm: 'active', wholesale: 'draft' },
      isActive: true,
      wholesale: true,
      price: { base: 100, wholesaleBase: 80 }
    }
  ]);
  assert.strictEqual(derived.ecomm, 'active');
  assert.strictEqual(derived.wholesale, 'draft');
}

function run() {
  testDraftVariantStaysInactive();
  testActivateEcommSyncsLegacyFlags();
  testDeriveFromMixedVariants();
  testEffectiveVariantUsesChannelVisibility();
  testWholesalePricingWithDraftVisibilityStaysDraft();
  testWholesalePricingWithActiveVisibilityIsActive();
  testWholesaleWithoutPricingNeverActive();
  testWholesaleEligibilityHelpers();
  testEcommUnaffectedByWholesalePricing();
  console.log('test-storefront-catalog-reconcile: all passed');
}

run();
