/**
 * Smoke test for Returns & Refunds product-return filter helpers.
 * Run: node scripts/verify-product-return-request-filter.js
 */
const assert = require('assert');
const {
  isCustomerProductReturnRequest,
  buildAdminProductReturnRequestMatch
} = require('../utils/productReturnRequest');

function run() {
  assert.strictEqual(
    isCustomerProductReturnRequest({
      returnInfo: {
        requestedAt: new Date(),
        refundContext: 'product_return',
        reasonType: 'damaged'
      }
    }),
    true,
    'explicit product_return must match'
  );

  assert.strictEqual(
    isCustomerProductReturnRequest({
      returnInfo: {
        requestedAt: new Date(),
        refundContext: 'cancellation',
        status: 'refund_pending'
      }
    }),
    false,
    'cancellation refund must NOT match'
  );

  assert.strictEqual(
    isCustomerProductReturnRequest({
      returnInfo: {
        requestedAt: new Date(),
        status: 'processed'
      }
    }),
    false,
    'requestedAt alone (no reason / context) must NOT match'
  );

  assert.strictEqual(
    isCustomerProductReturnRequest({
      returnInfo: {
        requestedAt: new Date(),
        reasonType: 'damaged'
      }
    }),
    true,
    'legacy damaged return without refundContext must still match'
  );

  assert.strictEqual(
    isCustomerProductReturnRequest({
      returnInfo: {
        requestedAt: new Date(),
        reasonType: 'wrong_item',
        refundContext: null
      }
    }),
    true,
    'legacy wrong_item with null refundContext must match'
  );

  assert.strictEqual(
    isCustomerProductReturnRequest({
      returnInfo: {
        requestedAt: new Date(),
        reasonType: 'damaged',
        refundContext: 'cancellation'
      }
    }),
    false,
    'cancellation context wins over reasonType'
  );

  const match = buildAdminProductReturnRequestMatch();
  assert.ok(match['returnInfo.requestedAt']);
  assert.ok(Array.isArray(match.$or));
  assert.ok(
    match.$or.some((c) => c['returnInfo.refundContext'] === 'product_return'),
    'mongo match includes product_return branch'
  );

  console.log('verify-product-return-request-filter: OK');
}

run();
