/**
 * Forward auto-sync candidate filter — Shiprocket + Shipmozo branches.
 * Run: node scripts/test-forward-auto-sync-filter.js
 */
const assert = require('assert');
const {
  buildAutoSyncCandidateFilter,
  hasShipmozoAwb,
  hasShiprocketReference,
} = require('../services/adminOrderAutoSync.service');

const from = new Date('2026-01-01T00:00:00.000Z');
const to = new Date('2026-12-31T23:59:59.999Z');

function testFilterShape() {
  const filter = buildAutoSyncCandidateFilter({ from, to, staleMs: 60_000 });
  const json = JSON.stringify(filter);
  assert.ok(json.includes('shipmozo'), 'filter includes Shipmozo branch');
  assert.ok(json.includes('shiprocket'), 'filter includes Shiprocket branch');
  assert.ok(json.includes('lastSyncAt'), 'filter includes stale lastSyncAt clause');
  assert.ok(json.includes('shipmozoOrderId'), 'filter includes Shipmozo order id for panel hydrate');
  console.log('ok filter shape has shipmozo + shiprocket branches');
}

function testAwbHelpers() {
  assert.strictEqual(hasShipmozoAwb({ awbCode: 'SM123' }), true);
  assert.strictEqual(hasShipmozoAwb({ trackingNumber: 'SM456' }), true);
  assert.strictEqual(hasShipmozoAwb({}), false);
  assert.strictEqual(hasShiprocketReference({ shiprocketOrderId: '99' }), true);
  console.log('ok AWB / reference helpers');
}

testFilterShape();
testAwbHelpers();
console.log('all test-forward-auto-sync-filter checks passed');
