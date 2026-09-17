/**
 * Shipmozo track event time + RTO reason mapping (no live API).
 * Run: node scripts/test-shipmozo-tracking-normalize.js
 */
const assert = require('assert');
const {
  parseShipmentEventDate,
  resolveShipmentEventAt,
  resolveShipmentEventTimeRaw
} = require('../services/shipmentOps/trackingEventTime');
const { mergeShipmentTrackingEvents } = require('../services/shipmentOps/trackingEventsMerge');
const {
  resolveRtoDisplayReason
} = require('../services/rtoRefund.service');

function testParseShipmozoDate() {
  const d = parseShipmentEventDate('2026-09-12 10:59:12');
  assert.ok(d instanceof Date);
  assert.ok(!Number.isNaN(d.getTime()));
  assert.strictEqual(parseShipmentEventDate(null), null);
  assert.strictEqual(parseShipmentEventDate(''), null);
}

function testResolveAtPrefersShipmozoTime() {
  const ev = {
    status: 'Not Contactable',
    location: 'BOM_Bhandup',
    time: '2026-08-31 05:31:03'
  };
  assert.strictEqual(resolveShipmentEventTimeRaw(ev), '2026-08-31 05:31:03');
  const at = resolveShipmentEventAt(ev);
  assert.ok(at instanceof Date);
  assert.ok(!Number.isNaN(at.getTime()));
}

function testMergeKeepsDistinctSameStatusDifferentTimes() {
  const incoming = [
    { status: 'New', location: 'A', time: '2026-08-25 16:17:18', at: parseShipmentEventDate('2026-08-25 16:17:18') },
    { status: 'New', location: 'A', time: '2026-08-26 07:31:48', at: parseShipmentEventDate('2026-08-26 07:31:48') },
    { status: 'Not Contactable', location: 'BOM_Bhandup', time: '2026-08-31 05:31:03', at: parseShipmentEventDate('2026-08-31 05:31:03') }
  ];
  const merged = mergeShipmentTrackingEvents([], incoming, 80);
  assert.strictEqual(merged.length, 3);
  assert.ok(merged.some((e) => e.status === 'Not Contactable'));
}

function testNotContactableReason() {
  const order = {
    shipmentInfo: {
      providerStatus: 'Return To Origin',
      rawEvents: [
        {
          status: 'Not Contactable',
          location: 'BOM_Bhandup',
          time: '2026-08-31 05:31:03',
          at: parseShipmentEventDate('2026-08-31 05:31:03'),
          raw: { status: 'Not Contactable', date: '2026-08-31 05:31:03', location: 'BOM_Bhandup' }
        },
        {
          status: 'Return To Origin',
          time: '2026-09-11 15:08:15',
          at: parseShipmentEventDate('2026-09-11 15:08:15')
        }
      ]
    },
    returnInfo: {}
  };
  const reason = resolveRtoDisplayReason(order);
  assert.strictEqual(reason, 'Not Contactable');
}

function testCanonicalMapFromShipmozoScan() {
  // Same mapping as utils/shipmozo.getTrackingByAwb
  const scans = [
    { date: '2026-08-31 05:31:03', status: 'Not Contactable', location: 'BOM_Bhandup' },
    { date: '2026-08-31 04:15:39', status: 'Out For Delivery', location: 'BOM_Bhandup' }
  ];
  const events = scans.map((s) => {
    const rawTime = s.time || s.status_time || s.timestamp || s.date || null;
    const at = parseShipmentEventDate(rawTime);
    return {
      status: String(s.status || '').trim() || 'Update',
      location: String(s.location || '').trim() || null,
      time: rawTime,
      date: rawTime,
      at: at || undefined,
      raw: s
    };
  });
  assert.strictEqual(events.length, 2);
  assert.ok(events.every((e) => e.at instanceof Date));
  assert.strictEqual(events.filter((e) => Boolean(e.at)).length, 2);
}

function run() {
  testParseShipmozoDate();
  testResolveAtPrefersShipmozoTime();
  testMergeKeepsDistinctSameStatusDifferentTimes();
  testNotContactableReason();
  testCanonicalMapFromShipmozoScan();
  console.log('All shipmozo tracking normalize tests passed.');
}

run();
