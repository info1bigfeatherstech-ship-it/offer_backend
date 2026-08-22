/**
 * Shipmozo panel sync — parser + reference helpers.
 * Run: node scripts/test-shipmozo-panel-sync.js
 */
const assert = require('assert');
const {
  parseShipmozoOrderDetail,
  resolveShipmozoMarketplaceOrderId,
  resolveShipmozoDetailOrderIds,
  hasShipmozoSyncReference,
  deepFindAwb,
  isShipmozoPanelBooked,
  isShipmozoPanelBookedStatus,
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

  const scheduledOnly = parseShipmozoOrderDetail({
    order_status: 'SCHEDULED',
    courier_name: 'XpressBees',
  });
  assert.strictEqual(scheduledOnly.awbCode, null);
  assert.strictEqual(scheduledOnly.courier, 'XpressBees');
  assert.strictEqual(scheduledOnly.providerStatus, 'SCHEDULED');

  const empty = parseShipmozoOrderDetail({});
  assert.strictEqual(empty.awbCode, null);
  console.log('ok parseShipmozoOrderDetail');
}

function testDeepFindAwb() {
  assert.strictEqual(
    deepFindAwb({ meta: { nested: { lr_number: '123456789012' } } }),
    '123456789012'
  );
  assert.strictEqual(deepFindAwb({ note: 'no awb here' }), null);
  console.log('ok deepFindAwb');
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

  const detailIds = resolveShipmozoDetailOrderIds({
    orderId: 'OWB-ECOMM-451824',
    shipmentInfo: { shipmozoOrderId: '15822AP989331462055' },
  });
  assert.ok(detailIds.includes('15822AP989331462055'));
  assert.ok(detailIds.includes('OWB-ECOMM-451824'));
  console.log('ok reference helpers');
}

function testPanelBooked() {
  assert.strictEqual(isShipmozoPanelBookedStatus('PUSHED'), false);
  assert.strictEqual(isShipmozoPanelBookedStatus('SCHEDULED'), true);
  assert.strictEqual(isShipmozoPanelBookedStatus('Data Received'), true);

  assert.strictEqual(
    isShipmozoPanelBooked({ providerStatus: 'SCHEDULED' }),
    true
  );
  assert.strictEqual(
    isShipmozoPanelBooked({ courier: 'Delhivery', providerStatus: 'PUSHED' }),
    true
  );
  assert.strictEqual(
    isShipmozoPanelBooked({ pickupScheduledAt: new Date() }),
    true
  );
  assert.strictEqual(isShipmozoPanelBooked({ providerStatus: 'PUSHED' }), false);
  console.log('ok panel booked detection');
}

testParseDetail();
testDeepFindAwb();
testReferences();
testPanelBooked();
console.log('all test-shipmozo-panel-sync checks passed');
