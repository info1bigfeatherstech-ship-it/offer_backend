/**
 * node backend/scripts/test-oos-inquiry-validation.js
 */
const assert = require('assert');
const {
  isValidInquiryEmail,
  isValidInquiryPhone,
  validateInquiryContact,
  isVariantOutOfStock,
  resolveInquiryWaitlistEligibility,
  normalizeInquiryPhone,
} = require('../utils/oosInquiryValidation');
const {
  isRestockTransition,
  shouldNotifyInquiryForStock,
} = require('../services/oosRestockNotify.service');

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

// --- Waitlist eligibility (ecomm unchanged, wholesale MOQ) ---
function wholesaleVariant(overrides = {}) {
  return {
    wholesale: true,
    price: { wholesaleBase: 100 },
    channelVisibility: { ecomm: 'active', wholesale: 'active' },
    inventory: { quantity: 5, trackInventory: true },
    minimumOrderQuantity: 100,
    ...overrides,
    inventory: {
      quantity: 5,
      trackInventory: true,
      ...(overrides.inventory || {}),
    },
  };
}

const listedWholesale = wholesaleVariant();

const ecommReject = resolveInquiryWaitlistEligibility(listedWholesale, 'ecomm');
assert.strictEqual(ecommReject.eligible, false);
assert.strictEqual(ecommReject.reason, null);

const wholesaleMoq = resolveInquiryWaitlistEligibility(listedWholesale, 'wholesale');
assert.strictEqual(wholesaleMoq.eligible, true);
assert.strictEqual(wholesaleMoq.reason, 'moq_unmet');

const wholesaleOos = resolveInquiryWaitlistEligibility(
  wholesaleVariant({ inventory: { quantity: 0, trackInventory: true } }),
  'wholesale'
);
assert.strictEqual(wholesaleOos.eligible, true);
assert.strictEqual(wholesaleOos.reason, 'out_of_stock');

const wholesaleOk = resolveInquiryWaitlistEligibility(
  wholesaleVariant({ inventory: { quantity: 100, trackInventory: true } }),
  'wholesale'
);
assert.strictEqual(wholesaleOk.eligible, false);

const ecommOos = resolveInquiryWaitlistEligibility(
  { inventory: { quantity: 0, trackInventory: true } },
  'ecomm'
);
assert.strictEqual(ecommOos.eligible, true);
assert.strictEqual(ecommOos.reason, 'out_of_stock');

// --- Restock transition ---
assert.strictEqual(isRestockTransition(0, 10, true), true);
assert.strictEqual(isRestockTransition(5, 10, true), false);
assert.strictEqual(isRestockTransition(5, 100, true, { minimumOrderQuantity: 100 }), true);
assert.strictEqual(isRestockTransition(5, 50, true, { minimumOrderQuantity: 100 }), false);
assert.strictEqual(isRestockTransition(0, 50, true, { minimumOrderQuantity: 100 }), true);
assert.strictEqual(isRestockTransition(5, 100, false, { minimumOrderQuantity: 100 }), false);

// --- Per-inquiry notify filter ---
const stockBelowMoq = { quantity: 50, minimumOrderQuantity: 100, trackInventory: true };
const stockAtMoq = { quantity: 100, minimumOrderQuantity: 100, trackInventory: true };
const stockPositive = { quantity: 10, minimumOrderQuantity: 100, trackInventory: true };

assert.strictEqual(
  shouldNotifyInquiryForStock({ storefront: 'ecomm', reason: 'out_of_stock' }, stockPositive),
  true
);
assert.strictEqual(
  shouldNotifyInquiryForStock({ storefront: 'wholesale', reason: 'out_of_stock' }, stockPositive),
  true
);
assert.strictEqual(
  shouldNotifyInquiryForStock({ storefront: 'wholesale', reason: 'moq_unmet' }, stockBelowMoq),
  false
);
assert.strictEqual(
  shouldNotifyInquiryForStock({ storefront: 'wholesale', reason: 'moq_unmet' }, stockAtMoq),
  true
);
assert.strictEqual(
  shouldNotifyInquiryForStock({ storefront: 'ecomm' }, { quantity: 5, minimumOrderQuantity: 1, trackInventory: true }),
  true
);

console.log('OK: oos inquiry validation + wholesale MOQ waitlist + restock notify rules');
