/**
 * Shipmozo substitute courier selection — unit tests (no API calls).
 * Run: node scripts/test-shipmozo-substitute-courier.js
 */
const assert = require('assert');
const {
  pickSubstituteCourier,
  listSubstituteCandidates,
  enrichSuggestedSm,
  isShipmozoServiceabilityAssignError,
  courierIdsEqual,
} = require('../services/shipmozoFulfillment.service');

const shadowfax = { courierId: 10, courierName: 'Shadowfax 2Kg', totalCharges: 47.2, codAvailable: true };
const delhivery = { courierId: 20, courierName: 'Delhivery', totalCharges: 52, codAvailable: true };
const xpressbees = { courierId: 30, courierName: 'XpressBees', totalCharges: 45, codAvailable: true };

function testExcludeQuotedCourier() {
  const picked = pickSubstituteCourier([shadowfax, delhivery, xpressbees], {
    maxCharge: 47.25,
    excludeCourierIds: [10],
  });
  assert.strictEqual(picked.courierId, 30);
  assert.strictEqual(picked.totalCharges, 45);
  console.log('ok exclude quoted courier from substitute');
}

function testExcludeQuotedWhenOnlyOneUnderCap() {
  const picked = pickSubstituteCourier([shadowfax, delhivery], {
    maxCharge: 47.25,
    excludeCourierIds: [10],
  });
  assert.strictEqual(picked, null, 'no substitute at or below cap when only quoted was under cap');

  const fallback = pickSubstituteCourier([shadowfax, delhivery], {
    maxCharge: 47.25,
    excludeCourierIds: [10],
    allowAboveMaxCharge: true,
  });
  assert.strictEqual(fallback.courierId, 20);
  console.log('ok above-cap fallback when quoted excluded');
}

function testListCandidatesOrder() {
  const list = listSubstituteCandidates([delhivery, shadowfax, xpressbees], {
    maxCharge: 47.25,
    excludeCourierIds: [10],
  });
  assert.deepStrictEqual(
    list.map((c) => c.courierId),
    [30]
  );
  console.log('ok listSubstituteCandidates ordering');
}

function testEnrichSuggested() {
  const enriched = enrichSuggestedSm(xpressbees, 47.2);
  assert.strictEqual(enriched.courierId, 30);
  assert.strictEqual(enriched.exceedsQuotedFreight, false);
  assert.ok(Number(enriched.freightGapInr) <= 0);

  const over = enrichSuggestedSm(delhivery, 47.2);
  assert.strictEqual(over.exceedsQuotedFreight, true);
  assert.ok(Number(over.freightGapInr) > 0);
  console.log('ok enrichSuggestedSm');
}

function testServiceabilityError() {
  assert.strictEqual(
    isShipmozoServiceabilityAssignError(
      'Shadow fax Courier not provide service for this 400086 pincode.'
    ),
    true
  );
  assert.strictEqual(isShipmozoServiceabilityAssignError('Courier already assigned'), false);
  console.log('ok isShipmozoServiceabilityAssignError');
}

function testCourierIdsEqual() {
  assert.strictEqual(courierIdsEqual(10, '10'), true);
  assert.strictEqual(courierIdsEqual(10, 20), false);
  console.log('ok courierIdsEqual');
}

testExcludeQuotedCourier();
testExcludeQuotedWhenOnlyOneUnderCap();
testListCandidatesOrder();
testEnrichSuggested();
testServiceabilityError();
testCourierIdsEqual();
console.log('all test-shipmozo-substitute-courier checks passed');
