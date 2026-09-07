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
    };
  }

  const [pwaInstallUsers, pushStats] = await Promise.all([
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
  ]);

  return {
    pwaInstallUsers,
    pushNotificationUsers: pushStats[0]?.pushUsers || 0,
    pushNotificationDevices: pushStats[0]?.pushDevices || 0,
    scopedCustomers: ids.length,
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
  listPushSubscribers,
  listPwaInstalls,
};
