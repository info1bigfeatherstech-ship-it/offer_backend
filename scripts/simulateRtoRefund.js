/*
  Simulate RTO refund calculation using existing service logic.
  This prints the calculated `maxRefundableInr`, paise amount sent to Razorpay,
  and a sample refund payload. It does NOT call Razorpay.

  Run: `node backend/scripts/simulateRtoRefund.js`
*/

const { calculateRtoRefund } = require('../services/rtoRefund.service');

function printResult(label, order, opts) {
  const calc = calculateRtoRefund(order, opts || {});
  const paise = Math.round((calc.maxRefundableInr || 0) * 100);
  console.log('---');
  console.log(label);
  console.log('Order snapshot:', {
    subtotal: order.subtotal,
    deliveryCharges: order.deliveryCharges,
    totalAmount: order.totalAmount,
    amountPaidInr: order.amountPaidInr,
    paymentMethod: order.paymentInfo?.method,
    paymentStatus: order.paymentStatus
  });
  console.log('Calculation:', JSON.stringify(calc, null, 2));
  console.log('Paise to send to Razorpay (amount):', paise);
  console.log('Sample refund payload:', JSON.stringify({ amount: paise, speed: 'normal', notes: { orderId: order.orderId, reason: 'rto_refund_simulation' } }, null, 2));
}

// Example orders to simulate
const examples = [
  {
    orderId: 'SIM-1001',
    subtotal: 1000,
    deliveryCharges: 50,
    totalAmount: 1050,
    amountPaidInr: 1050,
    paymentInfo: { method: 'online', razorpayPaymentId: 'pay_TEST_1' },
    paymentStatus: 'paid',
    shipmentInfo: { rawEvents: [{}, { rto_freight: 30 }], providerStatus: 'RTO Delivered to warehouse' }
  },
  {
    orderId: 'SIM-1002-COD',
    subtotal: 500,
    deliveryCharges: 40,
    totalAmount: 540,
    amountPaidInr: 0,
    paymentInfo: { method: 'cod' },
    paymentStatus: 'pending',
    shipmentInfo: { rawEvents: [], providerStatus: 'RTO Delivered to warehouse' }
  },
  {
    orderId: 'SIM-1003-PARTIAL',
    subtotal: 800,
    deliveryCharges: 30,
    totalAmount: 830,
    amountPaidInr: 400,
    paymentInfo: { method: 'online', razorpayPaymentId: 'pay_TEST_2' },
    paymentStatus: 'partially_paid',
    shipmentInfo: { rawEvents: [{ rto_charge: 25 }], providerStatus: 'RTO Delivered to warehouse' }
  }
];

for (const ex of examples) {
  printResult(`Example ${ex.orderId}`, ex);
}

console.log('\nSimulation complete. To perform a real test refund, provide Razorpay test keys and modify this script to call the Razorpay SDK.');
