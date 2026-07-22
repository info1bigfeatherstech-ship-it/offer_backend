/**
 * Offline unit checks for Phase 1 inventory stock overlay (no network).
 * Run: node scripts/test-inventory-stock-overlay.js
 */
const assert = require('assert');
const { normalizeProductCode, parseStockMap } = require('../services/externalInventory.service');
const { applyStockMapToProducts } = require('../services/inventoryStockOverlay.service');
const { getVariantAvailability } = require('../utils/storefrontCatalog');

function testNormalize() {
  assert.strictEqual(normalizeProductCode(' 34354-01 '), '34354-1');
  assert.strictEqual(normalizeProductCode('34354-1'), '34354-1');
  assert.strictEqual(normalizeProductCode('34354'), '34354');
  assert.strictEqual(normalizeProductCode('abc-02'), 'ABC-2');
  console.log('✓ normalizeProductCode');
}

function testParseStockMap() {
  const map = parseStockMap({
    '34354-01': { available: 3 },
    '34354-2': { available: 10 },
    'BAD': { available: 'x' }
  });
  assert.strictEqual(map.get('34354-1'), 3);
  assert.strictEqual(map.get('34354-2'), 10);
  assert.strictEqual(map.has('BAD'), false);
  console.log('✓ parseStockMap');
}

function testOverlayAppliesPerVariant() {
  const product = {
    totalStock: 99,
    variants: [
      {
        productCode: '34354-1',
        inventory: { quantity: 100, trackInventory: true },
        availability: getVariantAvailability(
          { inventory: { quantity: 100, trackInventory: true }, channelVisibility: { ecomm: 'active' }, isActive: true },
          'ecomm'
        )
      },
      {
        productCode: '34354-2',
        inventory: { quantity: 50, trackInventory: true },
        availability: getVariantAvailability(
          { inventory: { quantity: 50, trackInventory: true }, channelVisibility: { ecomm: 'active' }, isActive: true },
          'ecomm'
        )
      },
      {
        productCode: 'MISSING-1',
        inventory: { quantity: 7, trackInventory: true }
      }
    ]
  };

  // Force availability objects to single-storefront shape used by decorate API
  product.variants[0].availability = getVariantAvailability(product.variants[0], 'ecomm');
  product.variants[1].availability = getVariantAvailability(product.variants[1], 'ecomm');

  const stock = new Map([
    ['34354-1', 3],
    ['34354-2', 10]
  ]);
  const missing = new Set(['MISSING-1']);
  const result = applyStockMapToProducts([product], stock, missing, {
    storefront: 'ecomm',
    degraded: false
  });

  assert.strictEqual(product.variants[0].inventory.quantity, 3);
  assert.strictEqual(product.variants[0].inventory.stockSource, 'inventory');
  assert.strictEqual(product.variants[1].inventory.quantity, 10);
  assert.strictEqual(product.variants[2].inventory.quantity, 7, 'missing code keeps Mongo qty');
  assert.strictEqual(product.variants[2].inventory.stockSource, 'mongo_fallback');
  assert.strictEqual(product.totalStock, 3 + 10 + 7);
  assert.strictEqual(result.applied, 2);
  assert.ok(result.fallback >= 1);
  assert.strictEqual(product.variants[0].availability.status, 'IN_STOCK');
  console.log('✓ applyStockMapToProducts variant-level + fallback');
}

function testDegradedKeepsMongo() {
  const product = {
    variants: [
      { productCode: '34354-1', inventory: { quantity: 42, trackInventory: true } }
    ]
  };
  applyStockMapToProducts([product], new Map([['34354-1', 1]]), new Set(), {
    storefront: 'ecomm',
    degraded: true,
    reason: 'NETWORK_ERROR'
  });
  assert.strictEqual(product.variants[0].inventory.quantity, 42);
  assert.strictEqual(product.variants[0].inventory.stockSource, 'mongo_fallback_degraded');
  console.log('✓ degraded keeps Mongo quantity');
}

function testAnnotatePreservesMongoQuantity() {
  const product = {
    variants: [
      { productCode: '34354-1', inventory: { quantity: 100, trackInventory: true } },
      { productCode: 'MISSING-1', inventory: { quantity: 7, trackInventory: true } }
    ]
  };
  const result = applyStockMapToProducts(
    [product],
    new Map([['34354-1', 3]]),
    new Set(['MISSING-1']),
    { mode: 'annotate', degraded: false }
  );
  assert.strictEqual(product.variants[0].inventory.quantity, 100, 'Mongo qty unchanged');
  assert.strictEqual(product.variants[0].inventory.liveQuantity, 3);
  assert.strictEqual(product.variants[0].inventory.stockSource, 'inventory');
  assert.strictEqual(product.variants[1].inventory.quantity, 7);
  assert.strictEqual(product.variants[1].inventory.liveQuantity, null);
  assert.strictEqual(product.liveTotalStock, 3);
  assert.strictEqual(result.applied, 1);
  console.log('✓ annotate mode preserves Mongo + sets liveQuantity');
}

testNormalize();
testParseStockMap();
testOverlayAppliesPerVariant();
testDegradedKeepsMongo();
testAnnotatePreservesMongoQuantity();
console.log('\nAll Phase-1 overlay unit checks passed.');
