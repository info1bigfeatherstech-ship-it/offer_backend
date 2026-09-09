/**
 * Address courier street length — unit checks.
 * Run: node scripts/test-address-validation.js
 */
const assert = require('assert');
const {
  buildCourierStreetLines,
  validateCourierComposedStreet,
  validatePhysicalAddressForSave,
  sanitizeCourierConsigneeName,
  MAX_COURIER_COMBINED_STREET_CHARS,
  MAX_FULL_NAME_LEN,
  MAX_COURIER_CONSIGNEE_NAME_LEN
} = require('../utils/addressValidation');

function testComposeMatchesShiprocketShape() {
  const built = buildCourierStreetLines({
    houseNumber: 'Plot No 33, Shree Housing Society,Green Feld, Opposite Shivas Residency',
    building: 'Shivneri',
    floor: 'Behind Pratiksha Appartment,Zingabai Takali Nagpur',
    addressLine1: 'Godhani Road',
    addressLine2: '',
    area: 'Mankapur (Nagpur)',
    landmark: 'Opposite Shivas Residence and Behind Pratiksha Appartment'
  });
  assert.ok(built.line1.includes('Plot No 33'));
  assert.ok(built.line1.includes('Godhani Road'));
  assert.ok(built.line2.includes('Mankapur'));
  assert.strictEqual(built.combinedLength, built.line1.length + built.line2.length);
  assert.ok(
    built.combinedLength > MAX_COURIER_COMBINED_STREET_CHARS,
    `sample long address should exceed 190 (got ${built.combinedLength})`
  );
  const check = validateCourierComposedStreet({
    houseNumber: 'Plot No 33, Shree Housing Society,Green Feld, Opposite Shivas Residency',
    building: 'Shivneri',
    floor: 'Behind Pratiksha Appartment,Zingabai Takali Nagpur',
    addressLine1: 'Godhani Road',
    addressLine2: '',
    area: 'Mankapur (Nagpur)',
    landmark: 'Opposite Shivas Residence and Behind Pratiksha Appartment'
  });
  assert.strictEqual(check.ok, false);
  assert.strictEqual(check.code, 'COURIER_ADDRESS_TOO_LONG');
}

function testRejectLongAddressOnSave() {
  const res = validatePhysicalAddressForSave({
    fullName: 'Test User',
    phone: '9876543210',
    houseNumber: 'Plot No 33, Shree Housing Society, Green Feld',
    building: 'Shivneri',
    floor: 'Behind Pratiksha Appartment, Zingabai Takali Nagpur',
    addressLine1: 'Opposite Shivas Residency Godhani Road details here',
    addressLine2: 'extra line two content for length',
    area: 'Mankapur (Nagpur)',
    landmark: 'Opposite Shivas Residence and Behind Pratiksha Appartment',
    city: 'Nagpur',
    state: 'Maharashtra',
    postalCode: '440030',
    country: 'India'
  });
  assert.strictEqual(res.ok, false);
  assert.ok(
    res.errors.some((e) => e.code === 'COURIER_ADDRESS_TOO_LONG'),
    'expected COURIER_ADDRESS_TOO_LONG'
  );
}

function testAcceptReasonableAddress() {
  const res = validatePhysicalAddressForSave({
    fullName: 'Test User',
    phone: '9876543210',
    houseNumber: '42B',
    building: 'Sunrise',
    floor: '4',
    addressLine1: 'MG Road near metro station',
    addressLine2: 'Wing A',
    area: 'Andheri East',
    landmark: 'Near City Mall',
    city: 'Mumbai',
    state: 'Maharashtra',
    postalCode: '400069',
    country: 'India'
  });
  assert.strictEqual(res.ok, true, res.message);
  const courier = validateCourierComposedStreet(res.data);
  assert.strictEqual(courier.ok, true);
  assert.ok(courier.combinedLength <= MAX_COURIER_COMBINED_STREET_CHARS);
}

function testFullNameShipmozoCap() {
  assert.strictEqual(MAX_FULL_NAME_LEN, 50);
  assert.strictEqual(MAX_COURIER_CONSIGNEE_NAME_LEN, 50);

  const tooLong = validatePhysicalAddressForSave({
    fullName: 'A'.repeat(51),
    phone: '9876543210',
    houseNumber: '42B',
    building: 'Sunrise',
    floor: '4',
    addressLine1: 'MG Road near metro station',
    addressLine2: 'Wing A',
    area: 'Andheri East',
    landmark: 'Near City Mall',
    city: 'Mumbai',
    state: 'Maharashtra',
    postalCode: '400069',
    country: 'India'
  });
  assert.strictEqual(tooLong.ok, false);
  assert.ok(
    tooLong.errors.some((e) => e.code === 'FULL_NAME_TOO_LONG'),
    'expected FULL_NAME_TOO_LONG'
  );

  const atLimit = validatePhysicalAddressForSave({
    fullName: 'A'.repeat(50),
    phone: '9876543210',
    houseNumber: '42B',
    building: 'Sunrise',
    floor: '4',
    addressLine1: 'MG Road near metro station',
    addressLine2: 'Wing A',
    area: 'Andheri East',
    landmark: 'Near City Mall',
    city: 'Mumbai',
    state: 'Maharashtra',
    postalCode: '400069',
    country: 'India'
  });
  assert.strictEqual(atLimit.ok, true, atLimit.message);

  const sanitized = sanitizeCourierConsigneeName(
    'Davichand Sharma C/O Rajesh Thakkar Mathur Building 8 B Ground Floor New Owners'
  );
  assert.strictEqual(sanitized.length, 50);
  assert.strictEqual(sanitizeCourierConsigneeName('Davichand Sharma'), 'Davichand Sharma');
}

function run() {
  testComposeMatchesShiprocketShape();
  testRejectLongAddressOnSave();
  testAcceptReasonableAddress();
  testFullNameShipmozoCap();
  console.log('All address validation tests passed.');
}

run();
