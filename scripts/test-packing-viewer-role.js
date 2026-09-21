/**
 * packing_viewer role helpers — smoke test
 * Run: node scripts/test-packing-viewer-role.js
 */
const assert = require('assert');
const {
  isPackingViewerRole,
  isOrderReadStaffRole,
  isOrderWriteStaffRole,
  isPackingViewerListVisibleOrder,
  isPackingViewerDetailVisibleOrder,
  buildPackingViewerOrderMatch,
  resolvePackingViewerBucket,
  PACKING_VIEWER_BUCKETS
} = require('../utils/adminOrderRoles');

console.log('1) role checks');
assert.strictEqual(isPackingViewerRole('packing_viewer'), true);
assert.strictEqual(isOrderReadStaffRole('packing_viewer'), true);
assert.strictEqual(isOrderWriteStaffRole('packing_viewer'), false);
assert.strictEqual(isOrderWriteStaffRole('order_manager'), true);

console.log('2) list visibility — confirm through processing');
assert.strictEqual(isPackingViewerListVisibleOrder({ orderStatus: 'confirmed' }), true);
assert.strictEqual(
  isPackingViewerListVisibleOrder({
    orderStatus: 'processing',
    shipmentInfo: { labelDownloaded: false }
  }),
  true
);
assert.strictEqual(
  isPackingViewerListVisibleOrder({
    orderStatus: 'processing',
    shipmentInfo: { labelDownloaded: true }
  }),
  true
);
assert.strictEqual(isPackingViewerListVisibleOrder({ orderStatus: 'shipped' }), false);
assert.strictEqual(isPackingViewerListVisibleOrder({ orderStatus: 'out_for_delivery' }), false);
assert.strictEqual(isPackingViewerListVisibleOrder({ orderStatus: 'delivered' }), false);
assert.strictEqual(isPackingViewerListVisibleOrder({ orderStatus: 'pending' }), false);

console.log('3) detail visibility matches list');
assert.strictEqual(
  isPackingViewerDetailVisibleOrder({
    orderStatus: 'processing',
    shipmentInfo: { labelDownloaded: true }
  }),
  true
);
assert.strictEqual(isPackingViewerDetailVisibleOrder({ orderStatus: 'shipped' }), false);

console.log('4) buckets');
assert.deepStrictEqual([...PACKING_VIEWER_BUCKETS], [
  'bill_sent',
  'ready_to_ship',
  'ready_to_pick'
]);
assert.strictEqual(resolvePackingViewerBucket('bill_sent').empty, false);
assert.strictEqual(resolvePackingViewerBucket('ready_to_pick').empty, false);
assert.strictEqual(resolvePackingViewerBucket('in_transit').empty, true);
assert.strictEqual(resolvePackingViewerBucket('all').empty, false);

console.log('5) mongo match shape');
const m = buildPackingViewerOrderMatch();
assert.deepStrictEqual(m.orderStatus.$in, ['confirmed', 'processing']);

console.log('\nAll packing_viewer role tests passed.');
