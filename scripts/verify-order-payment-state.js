/**
 * Lightweight sanity checks for orderPaymentState helpers (no Jest required).
 * Run: node scripts/verify-order-payment-state.js
 */
const assert = require('assert');
const {
  recoverOrderStatusAfterSuccessfulCapture,
  recordOnlinePaymentAttemptFailure,
  isUnpaidTerminalOrder
} = require('../utils/orderPaymentState');

function run() {
  const paidFailed = {
    orderStatus: 'payment_failed',
    paymentStatus: 'paid',
    amountPaidInr: 895.36,
    paymentInfo: { status: 'failed', method: 'online' }
  };
  const r1 = recoverOrderStatusAfterSuccessfulCapture(paidFailed, { trigger: 'test' });
  assert.strictEqual(r1.changed, true);
  assert.strictEqual(paidFailed.orderStatus, 'pending');
  assert.strictEqual(paidFailed.paymentInfo.status, 'success');
  assert.strictEqual(isUnpaidTerminalOrder(paidFailed), false);

  const pendingFailAttempt = {
    orderStatus: 'pending',
    paymentStatus: 'pending',
    amountPaidInr: 0,
    paymentInfo: {
      method: 'online',
      sessions: [{ razorpayOrderId: 'order_A', status: 'created' }]
    }
  };
  const r2 = recordOnlinePaymentAttemptFailure(pendingFailAttempt, {
    order_id: 'order_A',
    id: 'pay_x',
    error_description: 'Bank declined',
    error_code: 'BAD_REQUEST_ERROR'
  });
  assert.strictEqual(r2.changed, true);
  assert.strictEqual(pendingFailAttempt.orderStatus, 'pending');
  assert.strictEqual(pendingFailAttempt.paymentStatus, 'pending');
  assert.strictEqual(pendingFailAttempt.paymentInfo.sessions[0].status, 'failed');
  assert.strictEqual(isUnpaidTerminalOrder(pendingFailAttempt), false);

  const alreadyPaid = {
    orderStatus: 'pending',
    paymentStatus: 'paid',
    amountPaidInr: 100,
    paymentInfo: { method: 'online', sessions: [] }
  };
  const r3 = recordOnlinePaymentAttemptFailure(alreadyPaid, {
    order_id: 'order_B',
    error_description: 'late fail'
  });
  assert.strictEqual(r3.changed, false);
  assert.strictEqual(alreadyPaid.paymentStatus, 'paid');

  const adminCancelledPaid = {
    orderStatus: 'cancelled',
    paymentStatus: 'paid',
    amountPaidInr: 50,
    paymentInfo: { cancellationReason: 'admin_cancelled' }
  };
  assert.strictEqual(isUnpaidTerminalOrder(adminCancelledPaid), true);
  const r4 = recoverOrderStatusAfterSuccessfulCapture(adminCancelledPaid, { trigger: 'test' });
  assert.strictEqual(r4.changed, false);
  assert.strictEqual(adminCancelledPaid.orderStatus, 'cancelled');

  console.log('verify-order-payment-state: OK');
}

run();
