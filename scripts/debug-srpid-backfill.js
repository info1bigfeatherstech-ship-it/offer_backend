/**
 * Debug SRPID backfill for orders missing shiprocketPickupId.
 * Usage: node scripts/debug-srpid-backfill.js [orderId]
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const Order = require('../models/Order');
const shiprocket = require('../utils/shiprocket');
const { ensureShiprocketPickupId, isEligibleForShiprocketPickupIdBackfill } = require('../services/shiprocketReconcile.service');

async function inspectOrder(order) {
  const si = order.shipmentInfo || {};
  console.log('\n---', order.orderId, '---');
  console.log({
    orderStatus: order.orderStatus,
    shiprocketPickupId: si.shiprocketPickupId || null,
    awb: si.awbCode || si.trackingNumber || null,
    shipmentId: si.shipmentId || null,
    shiprocketOrderId: si.shiprocketOrderId || null,
    eligible: isEligibleForShiprocketPickupIdBackfill(si)
  });

  const show = await shiprocket.fetchForwardOrderSnapshot({
    shiprocketOrderId: si.shiprocketOrderId,
    channelOrderId: order.orderId
  });
  console.log('orders/show pickup_id:', show?.snapshot?.shiprocketPickupId || '(none)');

  const batch = await shiprocket.fetchPickupBatchForShipment({
    shipmentId: si.shipmentId,
    shiprocketOrderId: si.shiprocketOrderId,
    channelOrderId: order.orderId
  });
  console.log('pickup list:', {
    success: batch.success,
    code: batch.code,
    shiprocketPickupId: batch.shiprocketPickupId || null
  });

  const result = await ensureShiprocketPickupId(order.orderId, 'debug_srpid');
  console.log('ensureShiprocketPickupId:', result);
}

async function main() {
  const targetId = process.argv[2];
  await mongoose.connect(process.env.MONGO_DB_URI || process.env.MONGODB_URI || process.env.MONGO_URI);
  console.log('Shiprocket enabled:', shiprocket.enabled);

  if (targetId) {
    const order = await Order.findOne({ orderId: targetId });
    if (!order) {
      console.error('Order not found:', targetId);
      process.exit(1);
    }
    await inspectOrder(order);
  } else {
    const missing = await Order.find({
      orderStatus: { $in: ['out_for_delivery', 'shipped', 'processing'] },
      $or: [
        { 'shipmentInfo.shiprocketPickupId': { $exists: false } },
        { 'shipmentInfo.shiprocketPickupId': null },
        { 'shipmentInfo.shiprocketPickupId': '' }
      ],
      $and: [
        {
          $or: [
            { 'shipmentInfo.awbCode': { $exists: true, $ne: null, $ne: '' } },
            { 'shipmentInfo.trackingNumber': { $exists: true, $ne: null, $ne: '' } }
          ]
        }
      ]
    })
      .sort({ updatedAt: -1 })
      .limit(5)
      .lean();

    console.log('Found', missing.length, 'in-transit orders missing SRPID (showing up to 5)');
    for (const doc of missing) {
      await inspectOrder(doc);
    }
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
