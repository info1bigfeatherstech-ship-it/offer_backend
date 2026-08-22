/**
 * Shipmozo panel sync — parser + reference helpers.
 * Run: node scripts/test-shipmozo-panel-sync.js
 */
const assert = require('assert');
const {
  parseShipmozoOrderDetail,
  resolveShipmozoMarketplaceOrderId,
  hasShipmozoSyncReference,
} = require('../services/shipmozoPanelSync.service');

function testParseDetail() {
  const flat = parseShipmozoOrderDetail({
    awb_number: '153291463404052',
    courier_name: 'XpressBees 0.5 Kg',
    courier_id: 29,
    order_status: 'Data Received',
    pickup_date: '2026-08-15',
  });
  assert.strictEqual(flat.awbCode, '153291463404052');
  assert.strictEqual(flat.courier, 'XpressBees 0.5 Kg');
  assert.strictEqual(flat.assignedCourierId, '29');
  assert.strictEqual(flat.providerStatus, 'Data Received');
  assert.strictEqual(flat.pickupDate, '2026-08-15');

  const nested = parseShipmozoOrderDetail({
    data: {
      order_id: '15822AP989331462055',
      shipment: {
        awb: 'AWB999',
        courier: 'Delhivery',
        status: 'Picked',
      },
    },
  });
  assert.strictEqual(nested.awbCode, 'AWB999');
  assert.strictEqual(nested.courier, 'Delhivery');
  assert.strictEqual(nested.providerStatus, 'Picked');

  const empty = parseShipmozoOrderDetail({});
  assert.strictEqual(empty.awbCode, null);
  console.log('ok parseShipmozoOrderDetail');
}

function testReferences() {
  assert.strictEqual(
    resolveShipmozoMarketplaceOrderId({ shipmozoOrderId: '15822AP989331462055' }),
    '15822AP989331462055'
  );
  assert.strictEqual(
    resolveShipmozoMarketplaceOrderId({ shipmentId: '15822AP989331462055' }),
    '15822AP989331462055'
  );
  assert.strictEqual(hasShipmozoSyncReference({ shipmozoOrderId: 'x' }), true);
  assert.strictEqual(hasShipmozoSyncReference({ awbCode: '123' }), true);
  assert.strictEqual(hasShipmozoSyncReference({}), false);
  console.log('ok reference helpers');
}

testParseDetail();
testReferences();
console.log('all test-shipmozo-panel-sync checks passed');
