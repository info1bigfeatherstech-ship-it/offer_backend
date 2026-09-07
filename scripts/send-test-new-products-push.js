/**
 * One-off: send new-products push template to active subscriptions.
 *
 * Usage:
 *   node scripts/send-test-new-products-push.js ecomm
 *   node scripts/send-test-new-products-push.js ecomm --email=dev@example.com
 *   node scripts/send-test-new-products-push.js wholesale --email=dev@example.com
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const PushSubscription = require('../models/PushSubscription');
const User = require('../models/User');
const {
  ensureVapidConfigured,
  isPushConfigured,
  dispatchWebPush,
  delay,
} = require('../utils/webPushDispatch');
const { buildPayload } = require('../services/newProductsPush.service');
const { normalizeCustomerStorefront } = require('../utils/customerStorefrontScope');

function parseArgs(argv) {
  const out = { storefront: 'ecomm', email: null };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--email=')) out.email = arg.slice('--email='.length).trim().toLowerCase();
    else if (!arg.startsWith('--')) out.storefront = arg;
  }
  return out;
}

async function main() {
  const { storefront: rawSf, email } = parseArgs(process.argv);
  const storefront = normalizeCustomerStorefront(rawSf);

  if (!isPushConfigured()) {
    console.error('PUSH_NOT_CONFIGURED — set VAPID keys in .env');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_DB_URI);
  ensureVapidConfigured();

  const basePayload = buildPayload(storefront);
  const payload = {
    ...basePayload,
    tag: `${basePayload.tag || 'new-products-digest'}-${Date.now()}`,
    data: {
      ...(basePayload.data || {}),
      test: true,
    },
  };

  let query = { isActive: true };
  if (email) {
    const user = await User.findOne({ email }).select('_id email').lean();
    if (!user) {
      console.error(`No user found for email=${email}`);
      await mongoose.disconnect();
      process.exit(1);
    }
    query.userId = user._id;
    console.log(`Filtering to user ${user._id} (${email})`);
  }

  const subs = await PushSubscription.find(query);
  console.log(`Active subscriptions matched: ${subs.length} (payload storefront: ${storefront})`);
  console.log('Payload:', {
    title: payload.title,
    body: payload.body,
    url: payload.data.url,
    icon: payload.icon,
  });

  if (!subs.length) {
    console.error(
      'No active subscriptions. On that browser: login → Allow notifications → re-run browser console self-test.'
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  let ok = 0;
  let fail = 0;
  for (const sub of subs) {
    const outcome = await dispatchWebPush(sub, payload, { logTag: 'testNewProductsPush' });
    if (outcome.ok) {
      ok += 1;
      console.log(`OK  user=${sub.userId} id=${sub._id}`);
    } else {
      fail += 1;
      console.log(
        `FAIL user=${sub.userId} id=${sub._id} reason=${outcome.reason || outcome.error || 'unknown'}`
      );
    }
    await delay(120);
  }

  console.log(`\nDone. sent=${ok} failed=${fail}`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});
