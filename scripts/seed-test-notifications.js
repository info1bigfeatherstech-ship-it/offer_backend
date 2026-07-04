/**
 * TEMPORARY — seed unread notifications for UI testing (bell swap / modal).
 * Delete this file when done testing.
 *
 * Default user: officedev591@gmail.com
 *
 * Usage (from project root or backend/):
 *   node backend/scripts/seed-test-notifications.js
 *   node backend/scripts/seed-test-notifications.js --email other@example.com
 *   node backend/scripts/seed-test-notifications.js --verify
 *   node backend/scripts/seed-test-notifications.js --cleanup
 *
 * After seed: login on storefront → header should show shaking bell (not hamburger).
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const User = require('../models/User');
const UserNotification = require('../models/UserNotification');

const SEED_TAG = 'notif_ui_test_seed';
const SEED_ORDER_PREFIX = 'OWB-NOTIF-TEST-';
const DEFAULT_EMAIL = 'officedev591@gmail.com';
const POLICY_URL =
  process.env.RTO_REFUND_POLICY_URL || 'https://offerwalebaba.com/policies/return-refund';

const NOTIFICATIONS = [
  {
    orderId: 'OWB-NOTIF-TEST-001',
    type: 'rto_initiated',
    title: 'Order Return Initiated',
    body:
      'Your order #OWB-NOTIF-TEST-001 has been returned to origin (RTO). Once we receive and fully verify the return at our warehouse, and your case is approved, your refund will be processed. We will notify you at each step.',
    metadata: { reason: 'eligible_full_paid', orderTotal: 1260, refundAmount: 1097, policyUrl: POLICY_URL }
  },
  {
    orderId: 'OWB-NOTIF-TEST-002',
    type: 'refund_not_applicable',
    title: 'Order Returned - Refund Not Applicable',
    body:
      'Your order #OWB-NOTIF-TEST-002 has been returned. Since this was a partial payment order, refund is not applicable as per our RTO policy. Please read our refund policy for more details: ' +
      POLICY_URL,
    metadata: { reason: 'partial_payment', orderTotal: 2080, policyUrl: POLICY_URL }
  },
  {
    orderId: 'OWB-NOTIF-TEST-003',
    type: 'refund_initiated',
    title: 'Refund Initiated',
    body:
      'Your refund of ₹704.50 for order #OWB-NOTIF-TEST-003 has been initiated. The amount should reflect in your account within 5-7 working days.',
    metadata: { reason: 'refund_initiated', refundAmount: 704.5, orderTotal: 910 }
  },
  {
    orderId: 'OWB-NOTIF-TEST-004',
    type: 'refund_rejected',
    title: 'Refund Cancelled',
    body:
      'Refund for order #OWB-NOTIF-TEST-004 has been cancelled. The return reason did not satisfy our refund policy requirements. No refund will be processed. For details: ' +
      POLICY_URL,
    metadata: { reason: 'admin_denied_refund', orderTotal: 1260, policyUrl: POLICY_URL }
  }
];

function parseEmailArg(argv) {
  const idx = argv.findIndex((a) => a === '--email' || a === '-e');
  if (idx >= 0 && argv[idx + 1]) return String(argv[idx + 1]).trim().toLowerCase();
  return DEFAULT_EMAIL;
}

async function findUserByEmail(email) {
  const user = await User.findOne({ email: email.toLowerCase().trim() }).select('_id email name');
  if (!user) {
    throw new Error(`User not found for email: ${email}`);
  }
  return user;
}

async function cleanup(email) {
  const user = await User.findOne({ email }).select('_id email');
  if (!user) {
    console.log(`No user for ${email} — nothing to clean.`);
    return;
  }
  const res = await UserNotification.deleteMany({
    userId: user._id,
    orderId: { $regex: `^${SEED_ORDER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` }
  });
  console.log(`\n🗑️  Deleted ${res.deletedCount} test notification(s) for ${email}`);
}

async function verify(email) {
  const user = await User.findOne({ email }).select('_id email name');
  if (!user) {
    console.log(`\n⚠️  User not found: ${email}`);
    return;
  }
  const filter = { userId: user._id, orderId: { $regex: `^${SEED_ORDER_PREFIX}` } };
  const total = await UserNotification.countDocuments(filter);
  const unread = await UserNotification.countDocuments({ ...filter, read: false });
  const rows = await UserNotification.find(filter).sort({ sentAt: -1 }).lean();

  console.log(`\n👤 ${user.name || user.email} (${user.email})`);
  console.log(`   Seeded notifications: ${total} (${unread} unread)`);
  for (const n of rows) {
    console.log(`   • [${n.read ? 'read' : 'UNREAD'}] ${n.type} — ${n.orderId} — ${n.title}`);
  }
  if (unread > 0) {
    console.log('\n✅ Login on site → header should show bell (not hamburger).');
  }
}

async function seed(email) {
  const user = await findUserByEmail(email);
  let created = 0;
  let updated = 0;

  for (const spec of NOTIFICATIONS) {
    const payload = {
      userId: user._id,
      orderId: spec.orderId,
      type: spec.type,
      title: spec.title,
      body: spec.body,
      read: false,
      sentAt: new Date(),
      metadata: { ...(spec.metadata || {}), seedTag: SEED_TAG }
    };

    const existing = await UserNotification.findOne({
      userId: user._id,
      orderId: spec.orderId,
      type: spec.type
    });

    if (existing) {
      await UserNotification.updateOne(
        { _id: existing._id },
        {
          $set: {
            title: payload.title,
            body: payload.body,
            read: false,
            sentAt: new Date(),
            metadata: payload.metadata
          }
        }
      );
      updated += 1;
      console.log(`↻ Reset unread: ${spec.type} — ${spec.orderId}`);
    } else {
      await UserNotification.create(payload);
      created += 1;
      console.log(`✚ Created: ${spec.type} — ${spec.orderId}`);
    }
  }

  console.log(`\nDone for ${user.email}: ${created} created, ${updated} reset to unread.`);
  await verify(email);
  console.log('\nWhen finished testing: node backend/scripts/seed-test-notifications.js --cleanup');
}

async function main() {
  const uri = process.env.MONGO_DB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_DB_URI is not set in backend/.env');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const email = parseEmailArg(args);
  const cleanupMode = args.includes('--cleanup') || args.includes('cleanup');
  const verifyOnly = args.includes('--verify') || args.includes('verify');

  await mongoose.connect(uri);
  console.log('Connected to MongoDB');

  try {
    if (cleanupMode) await cleanup(email);
    else if (verifyOnly) await verify(email);
    else await seed(email);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
