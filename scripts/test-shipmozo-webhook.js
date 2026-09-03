/**
 * Shipmozo webhook — parser / merge / cancel helpers (no DB / API).
 * Run: node scripts/test-shipmozo-webhook.js
 */
const assert = require('assert');
const {
  parseShipmozoWebhookPayload,
  mergeWebhookEvents,
  isCancelStatus,
  verifyShipmozoWebhookAuth,
} = require('../services/shipmozoWebhook.service');

function testParseSamplePayload() {
  const parsed = parseShipmozoWebhookPayload({
    order_id: 'OWB-ECOMM-1001',
    refrence_id: '15822AP999',
    awb_number: '153291456008075',
    carrier: 'Delhivery',
    expected_delivery_date: '2025-07-15 18:29:59',
    shipment_type: 'Forward',
    current_status: 'Delivered',
    status_time: '2025-07-15 09:12:16',
    status_feed: {
      scan: [
        {
          date: '2025-07-14 09:12:16',
          status: 'Delivered to consignee',
          location: 'Mumbai',
        },
        {
          date: '2025-07-14 06:08:36',
          status: 'Out for delivery',
          location: 'Mumbai',
        },
      ],
    },
  });
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.channelOrderId, 'OWB-ECOMM-1001');
  assert.strictEqual(parsed.referenceId, '15822AP999');
  assert.strictEqual(parsed.awbCode, '153291456008075');
  assert.strictEqual(parsed.currentStatus, 'Delivered');
  assert.strictEqual(parsed.courier, 'Delhivery');
  assert.strictEqual(parsed.events.length, 2);
  console.log('ok parseShipmozoWebhookPayload sample');
}

function testParseRequiresId() {
  const bad = parseShipmozoWebhookPayload({ current_status: 'In Transit' });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.code, 'SHIPMOZO_WEBHOOK_ID_REQUIRED');
  console.log('ok parse requires id');
}

function testNestedDataWrapper() {
  const parsed = parseShipmozoWebhookPayload({
    data: {
      order_id: 'OWB-1',
      awb_number: 'AWB1',
      current_status: 'In Transit',
    },
  });
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.awbCode, 'AWB1');
  console.log('ok nested data wrapper');
}

function testMergePrefersFullTimeline() {
  const order = {
    shipmentInfo: {
      rawEvents: [{ status: 'Old', time: '1' }],
    },
  };
  const merged = mergeWebhookEvents(
    order,
    [
      { status: 'Picked', time: 'a' },
      { status: 'In Transit', time: 'b' },
      { status: 'Delivered', time: 'c' },
    ],
    'Delivered',
    null
  );
  assert.strictEqual(merged.length, 3);
  assert.strictEqual(merged[2].status, 'Delivered');
  console.log('ok merge prefers full timeline');
}

function testCancelDetection() {
  assert.strictEqual(isCancelStatus('Cancelled'), true);
  assert.strictEqual(isCancelStatus('Shipment Cancelled'), true);
  assert.strictEqual(isCancelStatus('Delivered'), false);
  assert.strictEqual(isCancelStatus('In Transit'), false);
  console.log('ok cancel detection');
}

function testAuth() {
  const prev = process.env.SHIPMOZO_WEBHOOK_TOKEN;
  process.env.SHIPMOZO_WEBHOOK_TOKEN = 'secret-token';

  const bad = verifyShipmozoWebhookAuth({ headers: {}, query: {} });
  assert.strictEqual(bad.ok, false);

  const okHeader = verifyShipmozoWebhookAuth({
    headers: { 'x-shipmozo-token': 'secret-token' },
    query: {},
  });
  assert.strictEqual(okHeader.ok, true);

  const okQuery = verifyShipmozoWebhookAuth({
    headers: {},
    query: { token: 'secret-token' },
  });
  assert.strictEqual(okQuery.ok, true);

  if (prev == null) delete process.env.SHIPMOZO_WEBHOOK_TOKEN;
  else process.env.SHIPMOZO_WEBHOOK_TOKEN = prev;
  console.log('ok webhook auth');
}

testParseSamplePayload();
testParseRequiresId();
testNestedDataWrapper();
testMergePrefersFullTimeline();
testCancelDetection();
testAuth();
console.log('all test-shipmozo-webhook checks passed');
