const mongoose = require('mongoose');
const Wishlist = require('../models/Wishlist');
const User = require('../models/User');
const PushSubscription = require('../models/PushSubscription');
const wishlistReminderPushTemplate = require('../templates/wishlistReminderPush.template');
const {
  ensureVapidConfigured,
  isPushConfigured,
  dispatchWebPush,
  delay,
} = require('../utils/webPushDispatch');
const { getStorefrontFrontendBase } = require('../utils/storefrontFrontendUrl');
const leadsPushSettingsService = require('./leadsPushSettings.service');
const logger = require('../utils/logger');
const { normalizeCustomerStorefront } = require('../utils/customerStorefrontScope');

const MAX_BULK_RECIPIENTS = 50;
const SEND_DELAY_MS = 200;
const AUTO_BATCH_SIZE = 100;

function applyPlaceholders(text, vars) {
  let out = String(text || '');
  Object.entries(vars).forEach(([key, value]) => {
    out = out.split(`{{${key}}}`).join(String(value ?? ''));
  });
  return out;
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

function buildWishlistUrl(storefront) {
  const base = getStorefrontFrontendBase(storefront);
  const path = wishlistReminderPushTemplate.ctaPath || '/account/userwishlist';
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

function buildPushPayload({ customerName, itemCount, storefront }) {
  const displayName = customerName || 'there';
  const itemLabel = itemCount === 1 ? 'item' : 'items';
  const url = buildWishlistUrl(storefront);
  const vars = {
    name: displayName,
    itemCount: String(itemCount),
    itemLabel,
  };

  return {
    title: wishlistReminderPushTemplate.title,
    body: applyPlaceholders(wishlistReminderPushTemplate.body, vars),
    icon: wishlistReminderPushTemplate.icon,
    badge: wishlistReminderPushTemplate.badge,
    tag: wishlistReminderPushTemplate.tag,
    data: {
      type: 'wishlist-reminder',
      url,
      storefront,
    },
  };
}

async function sendWishlistReminderPushToUser({
  userId,
  userName,
  enforceDailyLimit = false,
  storefront = 'ecomm',
}) {
  const sf = normalizeCustomerStorefront(storefront);
  const wishlist = await Wishlist.findOne({ userId }).select('products').lean();
  const itemCount = Array.isArray(wishlist?.products) ? wishlist.products.length : 0;

  if (!itemCount) {
    return { status: 'skipped', reason: 'EMPTY_WISHLIST' };
  }

  const subscriptions = await PushSubscription.find({
    userId,
    isActive: true,
  });

  if (!subscriptions.length) {
    return { status: 'skipped', reason: 'NO_SUBSCRIPTION' };
  }

  const eligible = enforceDailyLimit
    ? subscriptions.filter((sub) => !wasReminderSentToday(sub.lastWishlistReminderPushAt))
    : subscriptions;

  if (!eligible.length) {
    return { status: 'skipped', reason: 'ALREADY_SENT_TODAY' };
  }

  const payload = buildPushPayload({
    customerName: userName,
    itemCount,
    storefront: sf,
  });

  let sent = 0;
  let failed = 0;

  for (const sub of eligible) {
    const outcome = await dispatchWebPush(sub, payload, {
      logTag: 'wishlistReminderPush',
      onSuccess: (doc) => {
        doc.lastWishlistReminderPushAt = new Date();
      },
    });
    if (outcome.ok) sent += 1;
    else failed += 1;
  }

  if (sent > 0) {
    return { status: 'sent', devices: sent, failedDevices: failed };
  }
  return { status: 'failed', reason: 'SEND_FAILED', failedDevices: failed };
}

async function sendBulkWishlistReminderPushes({ userIds, scopeQuery = {}, storefront = 'ecomm' }) {
  const sf = normalizeCustomerStorefront(storefront);
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
    storefront: sf,
  };

  const foundIds = new Set(users.map((u) => String(u._id)));

  for (let i = 0; i < users.length; i += 1) {
    const user = users[i];
    const userId = String(user._id);

    try {
      const outcome = await sendWishlistReminderPushToUser({
        userId: user._id,
        userName: user.name,
        enforceDailyLimit: false,
        storefront: sf,
      });

      if (outcome.status === 'sent') {
        results.sent += 1;
        results.details.push({ userId, status: 'sent', devices: outcome.devices });
      } else if (outcome.status === 'skipped') {
        results.skipped += 1;
        results.details.push({ userId, status: 'skipped', reason: outcome.reason });
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

async function sendAutoWishlistReminderPushes({ scopeQuery = {}, storefront = 'ecomm' } = {}) {
  const sf = normalizeCustomerStorefront(storefront);

  if (!isPushConfigured()) {
    return { skipped: true, reason: 'PUSH_NOT_CONFIGURED', storefront: sf };
  }

  const autoEnabled = await leadsPushSettingsService.isWishlistAutoPushEnabled(sf);
  if (!autoEnabled) {
    return { skipped: true, reason: 'AUTO_DISABLED', storefront: sf };
  }

  ensureVapidConfigured();

  const scopedUsers = await User.find(scopeQuery).select('_id name').lean();
  if (!scopedUsers.length) {
    return { sent: 0, skipped: 0, failed: 0, processedUsers: 0, storefront: sf };
  }

  const scopedUserIds = scopedUsers.map((u) => u._id);
  const userNameById = new Map(scopedUsers.map((u) => [String(u._id), u.name]));

  const wishlistsWithItems = await Wishlist.find({
    userId: { $in: scopedUserIds },
    'products.0': { $exists: true },
  })
    .select('userId')
    .lean();

  const wishlistUserIds = [...new Set(wishlistsWithItems.map((w) => String(w.userId)))];
  if (!wishlistUserIds.length) {
    return { sent: 0, skipped: 0, failed: 0, processedUsers: 0, storefront: sf };
  }

  const startOfToday = getStartOfTodayUtcForIst();
  const subscriptions = await PushSubscription.find({
    userId: { $in: wishlistUserIds },
    isActive: true,
    $or: [
      { lastWishlistReminderPushAt: null },
      { lastWishlistReminderPushAt: { $lt: startOfToday } },
    ],
  }).select('userId');

  const userIdsToNotify = [...new Set(subscriptions.map((s) => String(s.userId)))];
  if (!userIdsToNotify.length) {
    return { sent: 0, skipped: 0, failed: 0, processedUsers: 0, storefront: sf };
  }

  const results = { sent: 0, skipped: 0, failed: 0, processedUsers: 0, storefront: sf };

  for (let i = 0; i < userIdsToNotify.length; i += AUTO_BATCH_SIZE) {
    const batch = userIdsToNotify.slice(i, i + AUTO_BATCH_SIZE);
    for (const userId of batch) {
      results.processedUsers += 1;
      try {
        const outcome = await sendWishlistReminderPushToUser({
          userId,
          userName: userNameById.get(userId),
          enforceDailyLimit: true,
          storefront: sf,
        });
        if (outcome.status === 'sent') results.sent += 1;
        else if (outcome.status === 'skipped') results.skipped += 1;
        else results.failed += 1;
      } catch (err) {
        results.failed += 1;
        logger.error('[wishlistReminderPush] auto send user failed', {
          userId,
          storefront: sf,
          message: err?.message || String(err),
        });
      }
      await delay(SEND_DELAY_MS);
    }
  }

  logger.info('[wishlistReminderPush] auto run complete', results);
  return results;
}

module.exports = {
  sendBulkWishlistReminderPushes,
  sendAutoWishlistReminderPushes,
  MAX_BULK_RECIPIENTS,
};
