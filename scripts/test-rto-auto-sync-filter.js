/**
 * Smoke test: RTO auto-sync candidate filter shape (no Mongo / Shiprocket calls).
 * node backend/scripts/test-rto-auto-sync-filter.js
 */
const assert = require('assert');
const {
  buildRtoAutoSyncCandidateFilter,
  TERMINAL_RTO_ADMIN_STATUSES,
} = require('../services/adminRtoAutoSync.service');
const {
  resolveDateRange,
  buildScopedDateMatch,
} = require('../services/adminOrderDashboard.service');

const from = new Date('2026-01-01T00:00:00.000Z');
const to = new Date('2026-07-13T23:59:59.999Z');
const filter = buildRtoAutoSyncCandidateFilter({ from, to, staleMs: 15 * 60 * 1000 });

assert.ok(filter.$and && filter.$and.length >= 4, 'expected $and filter');
const andStr = JSON.stringify(filter);
assert.ok(andStr.includes('rto'), 'RTO bucket match present');
assert.ok(andStr.includes('lastSyncAt'), 'stale lastSyncAt present');
assert.ok(andStr.includes('shiprocketOrderId'), 'SR ref present');
assert.ok(
  TERMINAL_RTO_ADMIN_STATUSES.includes('refunded') &&
    TERMINAL_RTO_ADMIN_STATUSES.includes('closed'),
  'terminal statuses defined'
);

// Must not look like forward-only sync statuses list
assert.ok(!andStr.includes('pending') || andStr.includes('"rto"'), 'not forward-only pending filter');

// Lifetime / all: no createdAt window on auto-sync candidates.
const allFilter = buildRtoAutoSyncCandidateFilter({ staleMs: 15 * 60 * 1000 });
assert.ok(!JSON.stringify(allFilter).includes('createdAt'), 'all-time sync must not force createdAt');

const allRange = resolveDateRange({ rangePreset: 'all' });
assert.strictEqual(allRange.presetLabel, 'all');
assert.strictEqual(allRange.from, null);
assert.strictEqual(allRange.to, null);
const allMatch = buildScopedDateMatch(allRange.from, allRange.to, {});
assert.deepStrictEqual(allMatch, {});

const windowed = buildScopedDateMatch(from, to, {});
assert.ok(windowed.createdAt, 'windowed match keeps createdAt');

console.log('OK: buildRtoAutoSyncCandidateFilter shape looks correct');
console.log(JSON.stringify(filter, null, 2));
