const PushSubscription = require('../models/PushSubscription');
const { normalizePushSubscriptionInput } = require('../utils/pushSubscriptionValidation');
const logger = require('../utils/logger');

async function upsertPushSubscription({ userId, subscription, userAgent = null }) {
  const normalized = normalizePushSubscriptionInput(subscription);

  const doc = await PushSubscription.findOneAndUpdate(
    { endpoint: normalized.endpoint },
    {
      $set: {
        userId,
        keys: normalized.keys,
        userAgent: userAgent ? String(userAgent).slice(0, 512) : null,
        isActive: true,
        failureCount: 0,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  logger.info('[pushSubscription] upserted', {
    userId: String(userId),
    subscriptionId: String(doc._id),
  });

  return doc;
}

async function removePushSubscription({ userId, endpoint }) {
  const rawEndpoint = String(endpoint || '').trim();
  if (!rawEndpoint) {
    const err = new Error('endpoint is required');
    err.code = 'ENDPOINT_REQUIRED';
    throw err;
  }

  const result = await PushSubscription.deleteOne({
    userId,
    endpoint: rawEndpoint,
  });

  return { deleted: result.deletedCount > 0 };
}

async function getPushStatusForUser(userId) {
  const count = await PushSubscription.countDocuments({
    userId,
    isActive: true,
  });

  return {
    subscribed: count > 0,
    deviceCount: count,
  };
}

module.exports = {
  upsertPushSubscription,
  removePushSubscription,
  getPushStatusForUser,
};
