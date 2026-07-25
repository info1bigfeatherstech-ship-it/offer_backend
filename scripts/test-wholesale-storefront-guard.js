/**
 * Unit checks: wholesale transactional storefront guard.
 * Run: node scripts/test-wholesale-storefront-guard.js
 */
const assert = require('assert');
const {
  evaluateWholesaleTransactionalAccess
} = require('../middlewares/storefront.middleware');

function req(partial = {}) {
  return {
    userType: partial.userType || 'user',
    userRole: partial.userRole || partial.role || 'user',
    user: { role: partial.role || partial.userRole || 'user' },
    ...partial
  };
}

assert.strictEqual(evaluateWholesaleTransactionalAccess(req({ userType: 'wholesaler' })).allowed, true);
assert.strictEqual(
  evaluateWholesaleTransactionalAccess(req({ userType: 'admin', role: 'admin', userRole: 'admin' })).allowed,
  true
);
assert.strictEqual(
  evaluateWholesaleTransactionalAccess(
    req({ userType: 'user', role: 'order_manager', userRole: 'order_manager' })
  ).allowed,
  true
);
assert.strictEqual(
  evaluateWholesaleTransactionalAccess(
    req({ userType: 'user', role: 'product_manager', userRole: 'product_manager' })
  ).allowed,
  false
);
assert.strictEqual(
  evaluateWholesaleTransactionalAccess(
    req({ userType: 'user', role: 'marketing_manager', userRole: 'marketing_manager' })
  ).allowed,
  false
);
assert.strictEqual(evaluateWholesaleTransactionalAccess(req({ userType: 'user', role: 'user' })).allowed, false);

console.log('OK: wholesale storefront guard (wholesaler + order staff only)');
