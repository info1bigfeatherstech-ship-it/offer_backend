const { URL } = require('url');

const ALLOWED_PUSH_HOST_SUFFIXES = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'notify.windows.com',
  'push.apple.com',
  'web.push.apple.com',
  'push.services.mozilla.com',
];

function isAllowedPushEndpoint(endpoint) {
  const raw = String(endpoint || '').trim();
  if (!raw) return false;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return ALLOWED_PUSH_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`)
  );
}

function normalizePushSubscriptionInput(body) {
  const endpoint = String(body?.endpoint || '').trim();
  const p256dh = String(body?.keys?.p256dh || body?.p256dh || '').trim();
  const auth = String(body?.keys?.auth || body?.auth || '').trim();

  if (!endpoint || !p256dh || !auth) {
    const err = new Error('endpoint and keys (p256dh, auth) are required');
    err.code = 'INVALID_SUBSCRIPTION';
    throw err;
  }

  if (!isAllowedPushEndpoint(endpoint)) {
    const err = new Error('Push endpoint is not from a trusted provider');
    err.code = 'UNTRUSTED_ENDPOINT';
    throw err;
  }

  if (p256dh.length > 512 || auth.length > 256 || endpoint.length > 2048) {
    const err = new Error('Subscription payload is too large');
    err.code = 'INVALID_SUBSCRIPTION';
    throw err;
  }

  return {
    endpoint,
    keys: { p256dh, auth },
  };
}

module.exports = {
  isAllowedPushEndpoint,
  normalizePushSubscriptionInput,
};
