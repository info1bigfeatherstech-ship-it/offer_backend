/**
 * Offline checks for Phase-2 order stock bridge (no network / no DB).
 * Run: node scripts/test-order-stock-bridge.js
 */
const assert = require('assert');
const {
  splitCheckoutLines,
  attachProductCodesToOrderItems,
  emptyHold,
  readHold,
  writeHold
} = require('../services/orderStockBridge.service');

function testSplitLines() {
  const lines = [
    {
      quantity: 2,
      product: { _id: 'p1', name: 'A' },
      variant: {
        _id: 'v1',
        productCode: '34354-01',
        inventory: { trackInventory: true, quantity: 10 }
      }
    },
    {
      quantity: 1,
      product: { _id: 'p1', name: 'A' },
      variant: {
        _id: 'v2',
        productCode: '34354-2',
        inventory: { trackInventory: true, quantity: 5 }
      }
    },
    {
      quantity: 1,
      product: { _id: 'p2', name: 'B' },
      variant: {
        _id: 'v3',
        productCode: '',
        inventory: { trackInventory: true, quantity: 3 }
      }
    },
    {
      quantity: 9,
      product: { _id: 'p3', name: 'C' },
      variant: {
        _id: 'v4',
        productCode: 'SKIP-1',
        inventory: { trackInventory: false, quantity: 0 }
      }
    }
  ];

  const split = splitCheckoutLines(lines);
  assert.strictEqual(split.inventoryApiLines.length, 2);
  const byCode = Object.fromEntries(split.inventoryApiLines.map((l) => [l.productCode, l.quantity]));
  assert.strictEqual(byCode['34354-1'], 2);
  assert.strictEqual(byCode['34354-2'], 1);
  assert.strictEqual(split.mongoLines.length, 1);
  assert.strictEqual(split.allTrackableWithVariant.length, 3);
  console.log('✓ splitCheckoutLines');
}

function testAttachProductCodes() {
  const lines = [
    {
      variant: { _id: 'v1', productCode: '34354-01' },
      quantity: 1
    }
  ];
  const items = [{ productId: 'p', variantId: 'v1', quantity: 1 }];
  const out = attachProductCodesToOrderItems(items, lines);
  assert.strictEqual(out[0].productCode, '34354-1');
  console.log('✓ attachProductCodesToOrderItems');
}

function testHoldReadWrite() {
  const order = { inventoryHold: null, markModified() {} };
  assert.strictEqual(readHold(order).status, 'none');
  writeHold(order, emptyHold({ source: 'inventory', status: 'held', inventoryReserved: true }));
  assert.strictEqual(order.inventoryHold.status, 'held');
  assert.strictEqual(order.inventoryHold.inventoryReserved, true);
  console.log('✓ inventoryHold read/write');
}

testSplitLines();
testAttachProductCodes();
testHoldReadWrite();
console.log('\nAll Phase-2 bridge unit checks passed.');
