const User = require('../models/User');
const Product = require('../models/Product');
const PushSubscription = require('../models/PushSubscription');
const newProductsPushTemplate = require('../templates/newProductsPush.template');
const {
  ensureVapidConfigured,
  isPushConfigured,
  dispatchWebPush,
  delay,
} = require('../utils/webPushDispatch');
const { buildStorefrontUrl, resolvePushAssetUrl } = require('../utils/storefrontFrontendUrl');
const leadsPushSettingsService = require('./leadsPushSettings.service');
const logger = require('../utils/logger');
const { normalizeCustomerStorefront } = require('../utils/customerStorefrontScope');

const SEND_DELAY_MS = 150;
const AUTO_BATCH_SIZE = 80;

function buildActiveProductQuery(storefront, sinceDate) {
  const channel = storefront === 'wholesale' ? 'wholesale' : 'ecomm';
  const since = sinceDate instanceof Date && !Number.isNaN(sinceDate.getTime())
    ? sinceDate
    : new Date(0);

  return {
    createdAt: { $gt: since },
    $or: [
      { [`channelStatus.${channel}`]: 'active' },
      {
        $and: [
          {
            $or: [
              { [`channelStatus.${channel}`]: { $exists: false } },
              { [`channelStatus.${channel}`]: null },
            ],
          },
          { status: 'active' },
        ],
      },
    ],
  };
}

function buildPayload(storefront) {
  const sf = normalizeCustomerStorefront(storefront);
  const path =
    sf === 'wholesale'
      ? newProductsPushTemplate.wholesaleCtaPath ||
        newProductsPushTemplate.ctaPath ||
        '/TagProducts/today-arrival'
      : newProductsPushTemplate.ctaPath || '/#best-sellers';
  const url = buildStorefrontUrl(sf, path);

  return {
    title: newProductsPushTemplate.title,
    body: newProductsPushTemplate.body,
    icon: resolvePushAssetUrl(newProductsPushTemplate.icon, sf),
    badge: resolvePushAssetUrl(
      newProductsPushTemplate.badge || newProductsPushTemplate.icon,
      sf
    ),
    tag: newProductsPushTemplate.tag,
    actions: Array.isArray(newProductsPushTemplate.actions)
      ? newProductsPushTemplate.actions
      : [{ action: 'shop-new-arrivals', title: newProductsPushTemplate.ctaLabel || 'Shop New Arrivals' }],
    data: {
      type: 'new-products-digest',
      url,
      storefront: sf,
    },
  };
}

async function countNewProductsSince(storefront, sinceDate) {
  const sf = normalizeCustomerStorefront(storefront);
  return Product.countDocuments(buildActiveProductQuery(sf, sinceDate));
}

/**
 * Broadcast new-products digest to all active push subscribers in scope.
 * @param {{ storefront?: string, scopeQuery?: object, sinceDate?: Date|null }} opts
 */
async function sendNewProductsDigest({ storefront = 'ecomm', scopeQuery = {}, sinceDate = null } = {}) {
  const sf = normalizeCustomerStorefront(storefront);

  if (!isPushConfigured()) {
    return { skipped: true, reason: 'PUSH_NOT_CONFIGURED', storefront: sf };
  }

  const settings = await leadsPushSettingsService.getSettingsDoc(sf);
  if (!settings?.newProductsAutoPushEnabled) {
    return { skipped: true, reason: 'AUTO_DISABLED', storefront: sf };
  }

  const watermark =
    sinceDate instanceof Date
      ? sinceDate
      : settings.lastNewProductsDigestAt
        ? new Date(settings.lastNewProductsDigestAt)
        : new Date(0);

  const productCount = await countNewProductsSince(sf, watermark);
  if (!productCount) {
    return {
      skipped: true,
      reason: 'NO_NEW_PRODUCTS',
      storefront: sf,
      productCount: 0,
      watermark,
    };
  }

  ensureVapidConfigured();
  const payload = buildPayload(sf);

  const scopedUsers = await User.find(scopeQuery).select('_id').lean();
  if (!scopedUsers.length) {
    return {
      sent: 0,
      skipped: 0,
      failed: 0,
      productCount,
      storefront: sf,
      reason: 'NO_USERS_IN_SCOPE',
    };
  }

  const userIds = scopedUsers.map((u) => u._id);
  const subscriptions = await PushSubscription.find({
    userId: { $in: userIds },
    isActive: true,
  });

  if (!subscriptions.length) {
    return {
      sent: 0,
      skipped: 0,
      failed: 0,
      productCount,
      storefront: sf,
      reason: 'NO_SUBSCRIPTIONS',
    };
  }

  // One logical send per user (all devices).
  const byUser = new Map();
  for (const sub of subscriptions) {
    const key = String(sub.userId);
    if (!byUser.has(key)) byUser.set(key, []);
    byUser.get(key).push(sub);
  }

  const userKeys = [...byUser.keys()];
  const results = {
    sent: 0,
    skipped: 0,
    failed: 0,
    processedUsers: 0,
    productCount,
    storefront: sf,
    devicesSent: 0,
  };

  for (let i = 0; i < userKeys.length; i += AUTO_BATCH_SIZE) {
    const batch = userKeys.slice(i, i + AUTO_BATCH_SIZE);
    for (const userId of batch) {
      results.processedUsers += 1;
      const subs = byUser.get(userId) || [];
      let userSent = 0;

      for (const sub of subs) {
        const outcome = await dispatchWebPush(sub, payload, { logTag: 'newProductsPush' });
        if (outcome.ok) {
          userSent += 1;
          results.devicesSent += 1;
        }
        await delay(SEND_DELAY_MS);
      }

      if (userSent > 0) results.sent += 1;
      else results.failed += 1;
    }
  }

  logger.info('[newProductsPush] digest complete', results);
  return results;
}

module.exports = {
  sendNewProductsDigest,
  countNewProductsSince,
  buildActiveProductQuery,
  buildPayload,
};
