/**
 * One-time fix: set shipmentInfo.deliveredAt for manually delivered orders missing the field.
 * Run: node scripts/fix_delivered_at.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_DB_URI;
const ORDER_ID = 'OWB-ECOMM-53BF8AD58A744DB392';

async function main() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB');

  const result = await mongoose.connection.collection('orders').updateOne(
    { orderId: ORDER_ID },
    { $set: { 'shipmentInfo.deliveredAt': new Date() } }
  );

  console.log('matchedCount:', result.matchedCount);
  console.log('modifiedCount:', result.modifiedCount);

  if (result.matchedCount === 0) {
    console.log('❌ Order not found! Check orderId.');
  } else if (result.modifiedCount === 1) {
    console.log('✅ shipmentInfo.deliveredAt set successfully!');
  } else {
    console.log('⚠️ Order found but not modified (field may already exist).');
  }

  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
