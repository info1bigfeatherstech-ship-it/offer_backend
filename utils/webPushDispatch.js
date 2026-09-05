const webpush = require('web-push');
const {
  getVapidPublicKey,
  getVapidPrivateKey,
  getVapidSubject,
  isPushConfigured,
} = require('./pushVapid');
const logger = require('./logger');

let vapidConfigured = false;

function ensureVapidConfigured() {
  if (vapidConfigured) return;
  const publicKey = getVapidPublicKey();
  const privateKey = getVapidPrivateKey();
  if (!publicKey || !privateKey) {
    const err = new Error(
      'Web push is not configured. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY on the server.'
    );
    err.code = 'PUSH_NOT_CONFIGURED';
    throw err;
  }
  webpush.setVapidDetails(getVapidSubject(), publicKey, privateKey);
  vapidConfigured = true;
}

function isExpiredSubscriptionError(err) {
  const status = err?.statusCode || err?.status;
  return status === 404 || status === 410;
}

async function deactivateSubscription(subscriptionDoc, reason, logTag = 'webPush') {
  try {
    subscriptionDoc.isActive = false;
    await subscriptionDoc.save();
    logger.warn(`[${logTag}] subscription deactivated`, {
      subscriptionId: String(subscriptionDoc._id),
      userId: String(subscriptionDoc.userId),
      reason,
    });
  } catch (err) {
    logger.error(`[${logTag}] deactivate failed`, {
      subscriptionId: String(subscriptionDoc?._id),
      message: err?.message || String(err),
    });
  }
}

/**
 * Send one web-push notification and update subscription health fields.
 * @param {object} subscriptionDoc — mongoose PushSubscription doc
 * @param {object} payload — { title, body, icon, badge, tag, data }
 * @param {{ onSuccess?: (doc) => Promise<void>|void, logTag?: string }} [options]
 */
async function dispatchWebPush(subscriptionDoc, payload, options = {}) {
  ensureVapidConfigured();
  const logTag = options.logTag || 'webPush';

  const pushSubscription = {
    endpoint: subscriptionDoc.endpoint,
    keys: {
      p256dh: subscriptionDoc.keys.p256dh,
      auth: subscriptionDoc.keys.auth,
    },
  };

  const notificationPayload = JSON.stringify({
    title: payload.title,
    body: payload.body,
    icon: payload.icon,
    badge: payload.badge,
    tag: payload.tag,
    data: payload.data || {},
  });

  try {
    await webpush.sendNotification(pushSubscription, notificationPayload, {
      TTL: 60 * 60 * 12,
      urgency: 'normal',
    });

    subscriptionDoc.isActive = true;
    subscriptionDoc.failureCount = 0;
    subscriptionDoc.lastPushAt = new Date();
    if (typeof options.onSuccess === 'function') {
      await options.onSuccess(subscriptionDoc);
    }
    await subscriptionDoc.save();
    return { ok: true };
  } catch (err) {
    if (isExpiredSubscriptionError(err)) {
      await deactivateSubscription(subscriptionDoc, err.statusCode || err.status, logTag);
      return { ok: false, expired: true };
    }

    subscriptionDoc.failureCount = (subscriptionDoc.failureCount || 0) + 1;
    if (subscriptionDoc.failureCount >= 5) {
      subscriptionDoc.isActive = false;
    }
    try {
      await subscriptionDoc.save();
    } catch (saveErr) {
      logger.error(`[${logTag}] failureCount save failed`, {
        message: saveErr?.message || String(saveErr),
      });
    }

    logger.error(`[${logTag}] send failed`, {
      userId: String(subscriptionDoc.userId),
      subscriptionId: String(subscriptionDoc._id),
      message: err?.message || String(err),
      status: err?.statusCode || err?.status,
    });
    return { ok: false, expired: false };
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  ensureVapidConfigured,
  isPushConfigured,
  isExpiredSubscriptionError,
  deactivateSubscription,
  dispatchWebPush,
  delay,
};
