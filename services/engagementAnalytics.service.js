const mongoose = require('mongoose');
const User = require('../models/User');
const PushSubscription = require('../models/PushSubscription');
const logger = require('../utils/logger');

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parsePaging(query = {}) {
  const page = Math.max(1, parseInt(String(query.page || '1'), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(query.limit || '20'), 10) || 20));
  const search = String(query.search || '').trim().slice(0, 120);
  return { page, limit, skip: (page - 1) * limit, search };
}

function withSearch(userMatch, search) {
  const match = userMatch && typeof userMatch === 'object' ? userMatch : {};
  if (!search) return match;
  const rx = new RegExp(escapeRegex(search), 'i');
  return {
    $and: [match, { $or: [{ name: rx }, { email: rx }, { phone: rx }] }],
  };
}

/**
 * Record / confirm PWA install for a logged-in user (idempotent).
 */
async function recordPwaInstall(userId, { userAgent = null } = {}) {
  if (!userId) {
    const err = new Error('userId is required');
    err.code = 'USER_REQUIRED';
    throw err;
  }

  const now = new Date();
  const ua = userAgent ? String(userAgent).slice(0, 512) : null;
  const existing = await User.findById(userId).select('pwaInstall').lean();
  if (!existing) {
    const err = new Error('User not found');
    err.code = 'USER_NOT_FOUND';
    throw err;
  }

  const firstInstall = !existing.pwaInstall?.installedAt;
  const $set = {
    'pwaInstall.lastConfirmedAt': now,
  };
  if (ua) $set['pwaInstall.userAgent'] = ua;
  if (firstInstall) $set['pwaInstall.installedAt'] = now;

  await User.updateOne({ _id: userId }, { $set });

  logger.info('[pwaInstall] recorded', {
    userId: String(userId),
    firstInstall,
  });

  return {
    installedAt: existing.pwaInstall?.installedAt || now,
    lastConfirmedAt: now,
    firstInstall,
  };
}

async function getEngagementSummary(userMatch) {
  const match = userMatch && typeof userMatch === 'object' ? userMatch : {};
  const scopedUserIds = await User.find(match).select('_id').lean();
  const ids = scopedUserIds.map((u) => u._id);

  if (!ids.length) {
    return {
      pwaInstallUsers: 0,
      pushNotificationUsers: 0,
      pushNotificationDevices: 0,
      scopedCustomers: 0,
      pushNotificationUsersOff: 0,
      pwaInstallUsersOff: 0,
      pushAndPwaUsers: 0,
    };
  }

  const [pwaInstallUsers, pushStats, pushUserIds] = await Promise.all([
    User.countDocuments({
      _id: { $in: ids },
      'pwaInstall.installedAt': { $ne: null, $exists: true },
    }),
    PushSubscription.aggregate([
      { $match: { isActive: true, userId: { $in: ids } } },
      {
        $group: {
          _id: '$userId',
          devices: { $sum: 1 },
        },
      },
      {
        $group: {
          _id: null,
          pushUsers: { $sum: 1 },
          pushDevices: { $sum: '$devices' },
        },
      },
    ]),
    PushSubscription.distinct('userId', { isActive: true, userId: { $in: ids } }),
  ]);

  const activePushIds = (pushUserIds || [])
    .filter(Boolean)
    .map((id) =>
      id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(String(id))
    );

  const pushAndPwaUsers = activePushIds.length
    ? await User.countDocuments({
        _id: { $in: activePushIds },
        'pwaInstall.installedAt': { $ne: null, $exists: true },
      })
    : 0;

  return {
    pwaInstallUsers,
    pushNotificationUsers: pushStats[0]?.pushUsers || 0,
    pushNotificationDevices: pushStats[0]?.pushDevices || 0,
    scopedCustomers: ids.length,
    pushNotificationUsersOff: Math.max(0, ids.length - (pushStats[0]?.pushUsers || 0)),
    pwaInstallUsersOff: Math.max(0, ids.length - pwaInstallUsers),
    pushAndPwaUsers,
  };
}

/**
 * Active push subscriber userIds within an admin storefront userMatch.
 */
async function getActivePushUserIds(userMatch) {
  const match = userMatch && typeof userMatch === 'object' ? userMatch : {};
  const scopedUserIds = await User.find(match).select('_id').lean();
  const ids = scopedUserIds.map((u) => u._id);
  if (!ids.length) return [];

  const activeUserIds = await PushSubscription.distinct('userId', {
    isActive: true,
    userId: { $in: ids },
  });

  return activeUserIds
    .filter(Boolean)
    .map((id) =>
      id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(String(id))
    );
}

/**
 * Batch push device meta for a page of users.
 * @returns {Map<string, { deviceCount: number, subscribedAt: Date|null, lastPushAt: Date|null }>}
 */
async function getPushMetaForUserIds(userIds = []) {
  const map = new Map();
  const ids = (userIds || [])
    .filter(Boolean)
    .map((id) =>
      id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(String(id))
    );
  if (!ids.length) return map;

  const rows = await PushSubscription.aggregate([
    { $match: { isActive: true, userId: { $in: ids } } },
    {
      $group: {
        _id: '$userId',
        deviceCount: { $sum: 1 },
        subscribedAt: { $min: '$createdAt' },
        lastPushAt: { $max: '$lastPushAt' },
      },
    },
  ]);

  for (const row of rows) {
    map.set(String(row._id), {
      deviceCount: row.deviceCount || 0,
      subscribedAt: row.subscribedAt || null,
      lastPushAt: row.lastPushAt || null,
    });
  }
  return map;
}

/**
 * Normalize engagement filter query value.
 * @returns {'all'|'push_on'|'push_off'|'pwa_on'|'pwa_off'|'push_and_pwa'}
 */
function normalizeEngagementFilter(raw) {
  const key = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');
  const aliases = {
    both: 'push_and_pwa',
    ready: 'push_and_pwa',
    engaged: 'push_and_pwa',
    app_and_push: 'push_and_pwa',
  };
  const normalized = aliases[key] || key;
  const allowed = new Set([
    'all',
    'push_on',
    'push_off',
    'pwa_on',
    'pwa_off',
    'push_and_pwa',
  ]);
  if (!normalized || !allowed.has(normalized)) return 'all';
  return normalized;
}

/**
 * Apply engagement filter onto a user Mongo query.
 * For push_* / push_and_pwa filters, pass preloaded active push user ObjectIds.
 */
function applyEngagementFilterToUserQuery(baseQuery, engagement, pushUserIds = []) {
  const key = normalizeEngagementFilter(engagement);
  const base = baseQuery && typeof baseQuery === 'object' ? baseQuery : {};

  if (key === 'all') return base;

  if (key === 'pwa_on') {
    return {
      $and: [
        base,
        {
          'pwaInstall.installedAt': { $ne: null, $exists: true },
        },
      ],
    };
  }

  if (key === 'pwa_off') {
    return {
      $and: [
        base,
        {
          $or: [
            { pwaInstall: { $exists: false } },
            { 'pwaInstall.installedAt': null },
            { 'pwaInstall.installedAt': { $exists: false } },
          ],
        },
      ],
    };
  }

  const ids = Array.isArray(pushUserIds) ? pushUserIds : [];
  if (key === 'push_on') {
    if (!ids.length) {
      return { $and: [base, { _id: { $in: [] } }] };
    }
    return { $and: [base, { _id: { $in: ids } }] };
  }

  if (key === 'push_off') {
    if (!ids.length) return base;
    return { $and: [base, { _id: { $nin: ids } }] };
  }

  if (key === 'push_and_pwa') {
    if (!ids.length) {
      return { $and: [base, { _id: { $in: [] } }] };
    }
    return {
      $and: [
        base,
        { _id: { $in: ids } },
        { 'pwaInstall.installedAt': { $ne: null, $exists: true } },
      ],
    };
  }

  return base;
}

/**
 * Attach engagement fields for admin customer rows.
 */
function attachEngagementFields(user, pushMetaByUserId) {
  const meta = pushMetaByUserId?.get(String(user._id)) || null;
  const deviceCount = meta?.deviceCount || 0;
  return {
    ...user,
    notificationsEnabled: deviceCount > 0,
    pushDeviceCount: deviceCount,
    pushSubscribedAt: meta?.subscribedAt || null,
    pushLastPushAt: meta?.lastPushAt || null,
    pwaInstalled: Boolean(user?.pwaInstall?.installedAt),
    pwaInstalledAt: user?.pwaInstall?.installedAt || null,
    pwaLastConfirmedAt: user?.pwaInstall?.lastConfirmedAt || null,
  };
}

async function listPushSubscribers(userMatch, query = {}) {
  const { page, limit, skip, search } = parsePaging(query);
  const scopedQuery = withSearch(userMatch, search);

  const activeUserIds = await PushSubscription.distinct('userId', { isActive: true });
  const objectIds = activeUserIds
    .filter(Boolean)
    .map((id) => (id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(String(id))));

  const baseQuery = {
    $and: [scopedQuery, { _id: { $in: objectIds } }],
  };

  const [total, users] = await Promise.all([
    User.countDocuments(baseQuery),
    User.find(baseQuery)
      .select('name email phone status pwaInstall updatedAt')
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
  ]);

  const pageIds = users.map((u) => u._id);
  const deviceCounts = pageIds.length
    ? await PushSubscription.aggregate([
        { $match: { isActive: true, userId: { $in: pageIds } } },
        {
          $group: {
            _id: '$userId',
            deviceCount: { $sum: 1 },
            lastPushAt: { $max: '$lastPushAt' },
            subscribedAt: { $min: '$createdAt' },
          },
        },
      ])
    : [];
  const byUser = new Map(deviceCounts.map((r) => [String(r._id), r]));

  const data = users.map((u) => {
    const meta = byUser.get(String(u._id)) || {};
    return {
      _id: u._id,
      name: u.name || null,
      email: u.email || null,
      phone: u.phone || null,
      status: u.status || null,
      deviceCount: meta.deviceCount || 0,
      subscribedAt: meta.subscribedAt || null,
      lastPushAt: meta.lastPushAt || null,
      pwaInstalledAt: u.pwaInstall?.installedAt || null,
    };
  });

  return {
    data,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit) || 1),
    },
  };
}

async function listPwaInstalls(userMatch, query = {}) {
  const { page, limit, skip, search } = parsePaging(query);
  const scopedQuery = {
    $and: [
      withSearch(userMatch, search),
      { 'pwaInstall.installedAt': { $ne: null, $exists: true } },
    ],
  };

  const [total, users] = await Promise.all([
    User.countDocuments(scopedQuery),
    User.find(scopedQuery)
      .select('name email phone status pwaInstall')
      .sort({ 'pwaInstall.installedAt': -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
  ]);

  const pageIds = users.map((u) => u._id);
  const pushActive = pageIds.length
    ? await PushSubscription.aggregate([
        { $match: { isActive: true, userId: { $in: pageIds } } },
        { $group: { _id: '$userId', deviceCount: { $sum: 1 } } },
      ])
    : [];
  const pushMap = new Map(pushActive.map((r) => [String(r._id), r.deviceCount]));

  const data = users.map((u) => ({
    _id: u._id,
    name: u.name || null,
    email: u.email || null,
    phone: u.phone || null,
    status: u.status || null,
    installedAt: u.pwaInstall?.installedAt || null,
    lastConfirmedAt: u.pwaInstall?.lastConfirmedAt || null,
    userAgent: u.pwaInstall?.userAgent || null,
    pushDeviceCount: pushMap.get(String(u._id)) || 0,
    notificationsEnabled: (pushMap.get(String(u._id)) || 0) > 0,
  }));

  return {
    data,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit) || 1),
    },
  };
}

module.exports = {
  recordPwaInstall,
  getEngagementSummary,
  getActivePushUserIds,
  getPushMetaForUserIds,
  normalizeEngagementFilter,
  applyEngagementFilterToUserQuery,
  attachEngagementFields,
  listPushSubscribers,
  listPwaInstalls,
};
