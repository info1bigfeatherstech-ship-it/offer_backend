/**
 * node backend/scripts/test-oos-inquiry-validation.js
 */
const assert = require('assert');
const {
  isValidInquiryEmail,
  isValidInquiryPhone,
  validateInquiryContact,
  isVariantOutOfStock,
  normalizeInquiryPhone,
} = require('../utils/oosInquiryValidation');

assert.strictEqual(isValidInquiryEmail('testgmail'), false);
assert.strictEqual(isValidInquiryEmail('test@'), false);
assert.strictEqual(isValidInquiryEmail('test@gmail'), false);
assert.strictEqual(isValidInquiryEmail('name@gmail.com'), true);
assert.strictEqual(isValidInquiryEmail('a.b+c@mail.co.in'), true);

assert.strictEqual(isValidInquiryPhone('123'), false);
assert.strictEqual(isValidInquiryPhone('abcdefghij'), false);
assert.strictEqual(isValidInquiryPhone('5123456789'), false);
assert.strictEqual(isValidInquiryPhone('9876543210'), true);
assert.strictEqual(normalizeInquiryPhone('+91 98765-43210'), '9876543210');
assert.strictEqual(isValidInquiryPhone('+91 9876543210'), true);

assert.throws(() => validateInquiryContact({}), /Email is required/);
assert.throws(() => validateInquiryContact({ email: 'x@y.com' }), /Mobile number is required/);
assert.throws(
  () => validateInquiryContact({ email: 'x@y.com', phone: '123' }),
  /10-digit/
);

const ok = validateInquiryContact({ email: 'x@y.com', phone: '9876543210' });
assert.strictEqual(ok.email, 'x@y.com');
assert.strictEqual(ok.phone, '9876543210');

assert.strictEqual(isVariantOutOfStock({ inventory: { quantity: 0, trackInventory: true } }), true);
assert.strictEqual(isVariantOutOfStock({ inventory: { quantity: 2, trackInventory: true } }), false);
assert.strictEqual(isVariantOutOfStock({ inventory: { quantity: 0, trackInventory: false } }), false);

console.log('OK: oos inquiry validation (email + phone required)');
