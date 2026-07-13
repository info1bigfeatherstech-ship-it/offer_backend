/**
 * Unit tests — address intelligence + pending address edit helpers.
 * Run: node scripts/test-address-intelligence.js
 */
const assert = require('assert');
const {
  normalizeScorePercent,
  normalizeCategory,
  extractAddressIntelligenceFromShowRoot
} = require('../utils/addressIntelligenceNormalize');
const {
  computeLocalAddressQuality,
  buildShiprocketAddressIntelligence
} = require('../services/addressIntelligence.service');
const {
  pickEditableAddressPatch,
  buildMergedAddressCandidate,
  EDITABLE_ADDRESS_FIELDS,
  FROZEN_CONTACT_FIELDS
} = require('../services/adminPendingOrderAddressEdit.service');

function testNormalizeScore() {
  assert.strictEqual(normalizeScorePercent('0.96'), 96);
  assert.strictEqual(normalizeScorePercent(1), 100);
  assert.strictEqual(normalizeScorePercent('0.4'), 40);
  assert.strictEqual(normalizeScorePercent(71), 71);
  assert.strictEqual(normalizeScorePercent(null), null);
}

function testCategories() {
  assert.strictEqual(normalizeCategory('valid', 96), 'valid');
  assert.strictEqual(normalizeCategory('ambiguous', 40), 'ambiguous');
  assert.strictEqual(normalizeCategory('junk', 10), 'junk');
  assert.strictEqual(normalizeCategory(null, 85), 'valid');
  assert.strictEqual(normalizeCategory(null, 40), 'junk');
}

function testExtractFromShow() {
  const extracted = extractAddressIntelligenceFromShowRoot({
    address_score: '0.96',
    address_category: 'valid',
    address_risk: 'low',
    rto_risk: 'low'
  });
  assert.strictEqual(extracted.address_score, '0.96');
  assert.strictEqual(extracted.address_category, 'valid');

  const wrapped = extractAddressIntelligenceFromShowRoot({
    data: { address_score: 1, address_category: 'valid' }
  });
  assert.strictEqual(wrapped.address_score, 1);
}

function testShiprocketIntel() {
  const view = buildShiprocketAddressIntelligence({
    address_score: '0.96',
    address_category: 'valid',
    address_risk: 'low'
  });
  assert.strictEqual(view.source, 'shiprocket');
  assert.strictEqual(view.scorePercent, 96);
  assert.strictEqual(view.categoryLabel, 'Valid Address');
}

function testLocalQuality() {
  const good = computeLocalAddressQuality({
    fullName: 'Test User',
    phone: '9876543210',
    houseNumber: '415',
    building: 'Indra Nagar',
    floor: 'Ground Floor',
    addressLine1: 'Vakola pipe line Santacruz East near Papu Medical',
    addressLine2: 'Siddharth Nagar',
    area: 'Santacruz East',
    landmark: 'Near Papu Medical',
    city: 'Mumbai',
    state: 'Maharashtra',
    postalCode: '400055',
    country: 'India'
  });
  assert.ok(good.scorePercent >= 80);
  assert.strictEqual(good.source, 'local_pre_ship');
  assert.strictEqual(good.category, 'valid');

  const junkish = computeLocalAddressQuality({
    fullName: 'X',
    phone: '123',
    houseNumber: '',
    addressLine1: '12',
    area: '',
    city: '',
    state: '',
    postalCode: '12'
  });
  assert.ok(junkish.scorePercent < 50);
}

function testAddressPatchFreeze() {
  assert.ok(EDITABLE_ADDRESS_FIELDS.includes('postalCode'));
  assert.ok(FROZEN_CONTACT_FIELDS.includes('fullName'));
  assert.ok(FROZEN_CONTACT_FIELDS.includes('phone'));

  const patch = pickEditableAddressPatch({
    city: 'Pune',
    fullName: 'Hacker',
    phone: '1111111111',
    postalCode: '411001'
  });
  assert.strictEqual(patch.city, 'Pune');
  assert.strictEqual(patch.postalCode, '411001');
  assert.strictEqual(patch.fullName, undefined);
  assert.strictEqual(patch.phone, undefined);

  const merged = buildMergedAddressCandidate(
    {
      fullName: 'Real Name',
      phone: '9876543210',
      city: 'Mumbai',
      postalCode: '400055',
      houseNumber: '1',
      area: 'Andheri',
      addressLine1: 'Some street name here',
      state: 'Maharashtra'
    },
    { city: 'Pune', postalCode: '411001' }
  );
  assert.strictEqual(merged.fullName, 'Real Name');
  assert.strictEqual(merged.phone, '9876543210');
  assert.strictEqual(merged.city, 'Pune');
  assert.strictEqual(merged.postalCode, '411001');
}

function run() {
  testNormalizeScore();
  testCategories();
  testExtractFromShow();
  testShiprocketIntel();
  testLocalQuality();
  testAddressPatchFreeze();
  console.log('All address intelligence tests passed.');
}

run();
