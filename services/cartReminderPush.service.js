const webpush = require('web-push');
const mongoose = require('mongoose');
const Cart = require('../models/cart');
const User = require('../models/User');
const PushSubscription = require('../models/PushSubscription');
const cartReminderPushTemplate = require('../templates/cartReminderPush.template');
const leadsPushSettingsService = require('./leadsPushSettings.service');
const logger = require('../utils/logger');

const ADMIN_CART_PRODUCT_SELECT = 'name title slug variants';
const ADMIN_CART_POPULATE = [
  {
    path: 'items.productId',
    select: ADMIN_CART_PRODUCT_SELECT,
  },
];

const MAX_BULK_RECIPIENTS = 50;
const SEND_DELAY_MS = 200;
const AUTO_BATCH_SIZE = 100;

let vapidConfigured = false;

function getVapidPublicKey() {
  return String(process.env.VAPID_PUBLIC_KEY || '').trim();
}

function getVapidPrivateKey() {
  return String(process.env.VAPID_PRIVATE_KEY || '').trim();
}

function getVapidSubject() {
  const subject = String(process.env.VAPID_SUBJECT || '').trim();
  if (subject) return subject;
  const marketingEmail = String(process.env.MARKETING_EMAIL_USER || '').trim();
  if (marketingEmail) return `mailto:${marketingEmail}`;
  const otpEmail = String(process.env.EMAIL_USER || '').trim();
  if (otpEmail) return `mailto:${otpEmail}`;
  return 'mailto:support@offerwalebaba.com';
}

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

function isPushConfigured() {
  return Boolean(getVapidPublicKey() && getVapidPrivateKey());
}

function getStorefrontCartUrl() {
  const base = String(process.env.FRONTEND_URL || process.env.STORE_URL || 'https://offerwalebaba.com').replace(
    /\/$/,
    ''
  );
  return `${base}/account/usercart`;
}

function formatInr(amount) {
  const n = Number(amount) || 0;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n);
}

function getItemUnitPrice(priceSnapshot) {
  if (!priceSnapshot) return 0;
  return priceSnapshot.sale ?? priceSnapshot.base ?? 0;
}

function buildCartSummary(cartDoc) {
  const items = cartDoc?.items || [];
  const rows = items.filter((item) => (item.quantity || 0) > 0);
  const itemCount = rows.length;
  const totalAmount =
    cartDoc?.totalAmount != null && Number(cartDoc.totalAmount) > 0
      ? Number(cartDoc.totalAmount)
      : rows.reduce((sum, item) => {
          const unit = getItemUnitPrice(item.priceSnapshot);
          return sum + unit * (item.quantity || 1);
        }, 0);

  return { itemCount, totalAmount };
}

function applyPlaceholders(text, vars) {
  let out = String(text || '');
  Object.entries(vars).forEach(([key, value]) => {
    out = out.split(`{{${key}}}`).join(String(value ?? ''));
  });
  return out;
}

function buildPushPayload({ customerName, cartSummary }) {
  const { itemCount, totalAmount } = cartSummary;
  const itemLabel = itemCount === 1 ? 'item' : 'items';
  const displayName = customerName || 'there';
  const cartUrl = getStorefrontCartUrl();

  const vars = {
    name: displayName,
    itemCount: String(itemCount),
    itemLabel,
    cartTotal: formatInr(totalAmount),
  };

  return {
    title: cartReminderPushTemplate.title,
    body: applyPlaceholders(cartReminderPushTemplate.body, vars),
    icon: cartReminderPushTemplate.icon,
    badge: cartReminderPushTemplate.badge,
    tag: cartReminderPushTemplate.tag,
    url: cartUrl,
    data: {
      type: 'cart-reminder',
      url: cartUrl,
    },
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getStartOfTodayUtcForIst() {
  const now = new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffsetMs);
  const y = istNow.getUTCFullYear();
  const m = istNow.getUTCMonth();
  const d = istNow.getUTCDate();
  return new Date(Date.UTC(y, m, d) - istOffsetMs);
}

function wasReminderSentToday(lastSentAt) {
  if (!lastSentAt) return false;
  const startOfToday = getStartOfTodayUtcForIst();
  return new Date(lastSentAt).getTime() >= startOfToday.getTime();
}

async function sendPushToSubscription(subscriptionDoc, payload) {
  ensureVapidConfigured();

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
    data: payload.data,
  });

  await webpush.sendNotification(pushSubscription, notificationPayload, {
    TTL: 60 * 60 * 12,
    urgency: 'normal',
  });

  subscriptionDoc.isActive = true;
  subscriptionDoc.failureCount = 0;
  subscriptionDoc.lastPushAt = new Date();
  subscriptionDoc.lastCartReminderPushAt = new Date();
  await subscriptionDoc.save();
}

function isExpiredSubscriptionError(err) {
  const status = err?.statusCode || err?.status;
  return status === 404 || status === 410;
}

async function deactivateSubscription(subscriptionDoc, reason) {
  subscriptionDoc.isActive = false;
  await subscriptionDoc.save();
  logger.warn('[cartReminderPush] subscription deactivated', {
    subscriptionId: String(subscriptionDoc._id),
    userId: String(subscriptionDoc.userId),
    reason,
  });
}

async function sendCartReminderPushToUser({ userId, userName, scopeQuery = {}, enforceDailyLimit = false }) {
  const cartDoc = await Cart.findOne({ userId }).populate(ADMIN_CART_POPULATE).lean();
  const cartSummary = buildCartSummary(cartDoc);

  if (!cartSummary.itemCount) {
    return { status: 'skipped', reason: 'EMPTY_CART' };
  }

  const subscriptions = await PushSubscription.find({
    userId,
    isActive: true,
  });

  if (!subscriptions.length) {
    return { status: 'skipped', reason: 'NO_SUBSCRIPTION' };
  }

  const eligible = enforceDailyLimit
    ? subscriptions.filter((sub) => !wasReminderSentToday(sub.lastCartReminderPushAt))
    : subscriptions;

  if (!eligible.length) {
    return { status: 'skipped', reason: 'ALREADY_SENT_TODAY' };
  }

  const payload = buildPushPayload({
    customerName: userName,
    cartSummary,
  });

  let sent = 0;
  let failed = 0;

  for (const sub of eligible) {
    try {
      await sendPushToSubscription(sub, payload);
      sent += 1;
    } catch (err) {
      failed += 1;
      if (isExpiredSubscriptionError(err)) {
        await deactivateSubscription(sub, err.statusCode || err.status);
      } else {
        sub.failureCount = (sub.failureCount || 0) + 1;
        if (sub.failureCount >= 5) {
          sub.isActive = false;
        }
        await sub.save();
        logger.error('[cartReminderPush] send failed', {
          userId: String(userId),
          subscriptionId: String(sub._id),
          message: err?.message || String(err),
          status: err?.statusCode || err?.status,
        });
      }
    }
  }

  if (sent > 0) {
    return { status: 'sent', devices: sent, failedDevices: failed };
  }

  return { status: 'failed', reason: 'SEND_FAILED', failedDevices: failed };
}

/**
 * Manual bulk cart reminder push (admin).
 */
async function sendBulkCartReminderPushes({ userIds, scopeQuery = {} }) {
  const rawIds = Array.isArray(userIds) ? userIds : [];
  const uniqueIds = [...new Set(rawIds.map((id) => String(id || '').trim()).filter(Boolean))];

  if (!uniqueIds.length) {
    const err = new Error('At least one userId is required');
    err.code = 'USER_IDS_REQUIRED';
    throw err;
  }
  if (uniqueIds.length > MAX_BULK_RECIPIENTS) {
    const err = new Error(`Maximum ${MAX_BULK_RECIPIENTS} users per bulk send`);
    err.code = 'BULK_LIMIT_EXCEEDED';
    throw err;
  }

  const objectIds = uniqueIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
  if (!objectIds.length) {
    const err = new Error('No valid user IDs provided');
    err.code = 'INVALID_USER_IDS';
    throw err;
  }

  ensureVapidConfigured();

  const users = await User.find({
    _id: { $in: objectIds },
    ...scopeQuery,
  })
    .select('name email')
    .lean();

  const results = {
    sent: 0,
    skipped: 0,
    failed: 0,
    details: [],
  };

  const foundIds = new Set(users.map((u) => String(u._id)));

  for (let i = 0; i < users.length; i += 1) {
    const user = users[i];
    const userId = String(user._id);

    try {
      const outcome = await sendCartReminderPushToUser({
        userId: user._id,
        userName: user.name,
        scopeQuery,
        enforceDailyLimit: false,
      });

      if (outcome.status === 'sent') {
        results.sent += 1;
        results.details.push({
          userId,
          status: 'sent',
          devices: outcome.devices,
        });
      } else if (outcome.status === 'skipped') {
        results.skipped += 1;
        results.details.push({
          userId,
          status: 'skipped',
          reason: outcome.reason,
        });
      } else {
        results.failed += 1;
        results.details.push({
          userId,
          status: 'failed',
          reason: outcome.reason || 'SEND_FAILED',
        });
      }
    } catch (err) {
      results.failed += 1;
      results.details.push({
        userId,
        status: 'failed',
        reason: err?.message || 'SEND_FAILED',
      });
    }

    if (i < users.length - 1) {
      await delay(SEND_DELAY_MS);
    }
  }

  uniqueIds.forEach((id) => {
    if (!foundIds.has(id)) {
      results.skipped += 1;
      results.details.push({
        userId: id,
        status: 'skipped',
        reason: 'USER_NOT_IN_SCOPE_OR_NOT_FOUND',
      });
    }
  });

  return results;
}

/**
 * Auto daily push: users with cart items + active push subscription, max once per IST day.
 */
async function sendAutoCartReminderPushes({ scopeQuery = {} } = {}) {
  if (!isPushConfigured()) {
    return { skipped: true, reason: 'PUSH_NOT_CONFIGURED' };
  }

  const autoEnabled = await leadsPushSettingsService.isAutoPushEnabled('ecomm');
  if (!autoEnabled) {
    return { skipped: true, reason: 'AUTO_DISABLED' };
  }

  ensureVapidConfigured();

  const scopedUsers = await User.find(scopeQuery).select('_id name').lean();
  if (!scopedUsers.length) {
    return { sent: 0, skipped: 0, failed: 0, processedUsers: 0 };
  }

  const scopedUserIds = scopedUsers.map((u) => u._id);
  const userNameById = new Map(scopedUsers.map((u) => [String(u._id), u.name]));

  const cartsWithItems = await Cart.find({
    userId: { $in: scopedUserIds },
    'items.0': { $exists: true },
  })
    .select('userId')
    .lean();

  const cartUserIds = [...new Set(cartsWithItems.map((c) => String(c.userId)))];
  if (!cartUserIds.length) {
    return { sent: 0, skipped: 0, failed: 0, processedUsers: 0 };
  }

  const startOfToday = getStartOfTodayUtcForIst();
  const subscriptions = await PushSubscription.find({
    userId: { $in: cartUserIds },
    isActive: true,
    $or: [
      { lastCartReminderPushAt: null },
      { lastCartReminderPushAt: { $lt: startOfToday } },
    ],
  }).select('userId');

  const userIdsToNotify = [...new Set(subscriptions.map((s) => String(s.userId)))];
  if (!userIdsToNotify.length) {
    return { sent: 0, skipped: 0, failed: 0, processedUsers: 0 };
  }

  const results = { sent: 0, skipped: 0, failed: 0, processedUsers: 0 };

  for (let i = 0; i < userIdsToNotify.length; i += AUTO_BATCH_SIZE) {
    const batch = userIdsToNotify.slice(i, i + AUTO_BATCH_SIZE);

    for (const userId of batch) {
      results.processedUsers += 1;
      try {
        const outcome = await sendCartReminderPushToUser({
          userId,
          userName: userNameById.get(userId),
          enforceDailyLimit: true,
        });

        if (outcome.status === 'sent') results.sent += 1;
        else if (outcome.status === 'skipped') results.skipped += 1;
        else results.failed += 1;
      } catch (err) {
        results.failed += 1;
        logger.error('[cartReminderPush] auto send user failed', {
          userId,
          message: err?.message || String(err),
        });
      }

      await delay(SEND_DELAY_MS);
    }
  }

  logger.info('[cartReminderPush] auto run complete', results);
  return results;
}

module.exports = {
  getVapidPublicKey,
  isPushConfigured,
  sendBulkCartReminderPushes,
  sendAutoCartReminderPushes,
  MAX_BULK_RECIPIENTS,
};
