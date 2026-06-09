/**
 * Validates web push configuration and subscription sanitization.
 * Run: node scripts/validate-push-setup.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const {
  isPushConfigured,
  getVapidPublicKey,
} = require('../services/cartReminderPush.service');
const {
  normalizePushSubscriptionInput,
  isAllowedPushEndpoint,
} = require('../utils/pushSubscriptionValidation');

let failed = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failed += 1;
  } else {
    console.log(`OK: ${message}`);
  }
}

assert(
  isAllowedPushEndpoint('https://fcm.googleapis.com/fcm/send/example'),
  'allows Google FCM endpoint'
);
assert(
  !isAllowedPushEndpoint('http://evil.example.com/push'),
  'rejects non-HTTPS endpoint'
);
assert(
  !isAllowedPushEndpoint('https://evil.example.com/push'),
  'rejects untrusted HTTPS host'
);

try {
  normalizePushSubscriptionInput({
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
    keys: { p256dh: 'test', auth: 'test' },
  });
  assert(true, 'normalizes valid subscription');
} catch (err) {
  assert(false, `valid subscription should pass (${err.message})`);
}

try {
  normalizePushSubscriptionInput({ endpoint: 'https://evil.com', keys: { p256dh: 'a', auth: 'b' } });
  assert(false, 'untrusted endpoint should throw');
} catch (err) {
  assert(err.code === 'UNTRUSTED_ENDPOINT', 'untrusted endpoint throws UNTRUSTED_ENDPOINT');
}

if (isPushConfigured()) {
  assert(getVapidPublicKey().length > 20, 'VAPID public key loaded from env');
  console.log('Push is configured and ready for production sends.');
} else {
  console.log('INFO: VAPID keys not set — push sends disabled until env is configured.');
}

if (failed > 0) {
  console.error(`\n${failed} validation check(s) failed.`);
  process.exit(1);
}

console.log('\nAll push setup validations passed.');
