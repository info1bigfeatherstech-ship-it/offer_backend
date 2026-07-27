/**
 * Heal OWB-ECOMM-58E583CDE1C543E3AC after Razorpay over-refund + DB desync.
 *
 * Reality on Razorpay (from ops): paid 150.36, refunded 101.36, remaining captured ~49.
 * Panel was stuck with pending=true, refundHistory=[], amountPaidInr=150.36.
 *
 * This script syncs Mongo to Razorpay money reality and clears settlement pending.
 * Does NOT call Razorpay again.
 *
 * Usage (from backend/):
 *   node scripts/heal-oos-order-58E583CDE1C543E3AC.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Order = require('../models/Order');

const ORDER_ID = 'OWB-ECOMM-58E583CDE1C543E3AC';
const RAZORPAY_REFUND_AMOUNT_INR = 101.36;
const REMAINING_CAPTURED_INR = 49;
// Correct settlement would have been ~49 refund with ship ~52.36 kept; document over-refund.
const HELD_SHIP_INR = 52.36;

async function main() {
  const uri = process.env.MONGO_DB_URI || process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_DB_URI missing in env');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const order = await Order.findOne({ orderId: ORDER_ID });
  if (!order) {
    console.error('Order not found', ORDER_ID);
    process.exit(1);
  }

  console.log('Before:', {
    totalAmount: order.totalAmount,
    amountPaidInr: order.amountPaidInr,
    deliveryCharges: order.deliveryCharges,
    pending: order.paymentInfo?.oosShippingSettlement?.pending,
    refundHistoryLen: (order.refundHistory || []).length
  });

  const meta = order.paymentInfo?.oosShippingSettlement || {};
  order.refundHistory = order.refundHistory || [];
  const already = order.refundHistory.some(
    (r) => Number(r.amountInr) === RAZORPAY_REFUND_AMOUNT_INR || r.reason === 'oos_settle_razorpay_desync_heal'
  );
  if (!already) {
    order.refundHistory.push({
      refundId: `heal_sync_${Date.now()}`,
      amountInr: RAZORPAY_REFUND_AMOUNT_INR,
      amountPaise: Math.round(RAZORPAY_REFUND_AMOUNT_INR * 100),
      status: 'processed',
      reason: 'oos_settle_razorpay_desync_heal',
      createdAt: new Date()
    });
  }

  // Align to money left on Razorpay (~₹49 item only after over-refund of shipping too).
  order.subtotal = 49;
  order.deliveryCharges = 0;
  order.tax = 0;
  order.discount = 0;
  order.totalAmount = REMAINING_CAPTURED_INR;
  order.amountPaidInr = REMAINING_CAPTURED_INR;
  order.balanceDueInr = 0;
  order.paymentStatus = 'paid';
  order.paymentInfo = order.paymentInfo || {};
  order.paymentInfo.fullOrderAmountPaise = Math.round(REMAINING_CAPTURED_INR * 100);
  order.paymentInfo.oosShippingSettlement = {
    ...meta,
    pending: false,
    settledAt: new Date().toISOString(),
    healNote:
      'Synced after Razorpay refund 101.36 with DB desync. Correct refund should have been ~49 (item only) keeping shipping ~52.36. Over-refund absorbed.',
    heldDeliveryCharges: HELD_SHIP_INR,
    actualFreightInr: HELD_SHIP_INR,
    customerDelivery: 0,
    freightSource: 'heal_after_overrefund',
    refundInr: RAZORPAY_REFUND_AMOUNT_INR,
    refundStatus: 'ok_healed',
    policyVersion: 3,
    source: 'manual_heal_script'
  };
  order.markModified('paymentInfo');
  order.markModified('refundHistory');

  order.adminEditHistory = order.adminEditHistory || [];
  order.adminEditHistory.push({
    action: 'oos_settle_razorpay_desync_heal',
    note: 'Healed panel after Razorpay over-refund 101.36 / DB pending stuck',
    createdAt: new Date(),
    metadata: {
      razorpayRefundInr: RAZORPAY_REFUND_AMOUNT_INR,
      remainingCapturedInr: REMAINING_CAPTURED_INR,
      correctRefundWouldHaveBeenInr: 49,
      heldShipInr: HELD_SHIP_INR
    }
  });
  order.markModified('adminEditHistory');

  order.customerFacingNotes = order.customerFacingNotes || [];
  order.customerFacingNotes.push({
    message:
      'Your order totals were updated after shipping. A refund was processed for unavailable items / order adjustment.',
    kind: 'order_amended',
    createdAt: new Date(),
    metadata: { healed: true, refundInr: RAZORPAY_REFUND_AMOUNT_INR }
  });
  order.markModified('customerFacingNotes');

  await order.save();

  console.log('After:', {
    totalAmount: order.totalAmount,
    amountPaidInr: order.amountPaidInr,
    deliveryCharges: order.deliveryCharges,
    pending: order.paymentInfo?.oosShippingSettlement?.pending,
    refundHistoryLen: (order.refundHistory || []).length
  });
  console.log('Heal complete for', ORDER_ID);
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  try {
    await mongoose.disconnect();
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
