/**
 * Atomic refresh-token session store.
 *
 * All mutations use MongoDB operators ($push, $pull, positional $set) so concurrent
 * logins/refreshes on different devices never overwrite each other's sessions via
 * read-modify-write on the full User document.
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');

const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REFRESH_ROTATION_GRACE_MS = 60 * 1000;

const REFRESH_TOKEN_SELECT =
  '+refreshTokens.token +refreshTokens.previousToken +refreshTokens.previousTokenValidUntil +refreshTokens.deviceInfo +refreshTokens.expiresAt +refreshTokens.createdAt';

function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function refreshTokenExpiresAt(fromMs = Date.now()) {
  return new Date(fromMs + REFRESH_TOKEN_TTL_MS);
}

function rotationGraceUntil(fromMs = Date.now()) {
  return new Date(fromMs + REFRESH_ROTATION_GRACE_MS);
}

function verifyRefreshJwt(refreshToken) {
  if (!refreshToken) return null;
  try {
    const decoded = jwt.verify(refreshToken, process.env.REFRESH_TOKEN_SECRET);
    if (decoded?.type !== 'refresh' || !decoded?.id) return null;
    return decoded;
  } catch {
    return null;
  }
}

/**
 * @param {import('mongoose').Types.ObjectId|string} userId
 * @param {{ hashedToken: string, deviceInfo?: string, createdAt?: Date, expiresAt?: Date }} entry
 */
async function appendSession(userId, entry) {
  const now = new Date();
  const sessionEntry = {
    token: entry.hashedToken,
    expiresAt: entry.expiresAt || refreshTokenExpiresAt(now.getTime()),
    createdAt: entry.createdAt || now,
    deviceInfo: entry.deviceInfo || 'Unknown'
  };

  await User.updateOne(
    { _id: userId },
    { $pull: { refreshTokens: { expiresAt: { $lte: now } } } }
  );

  await User.updateOne({ _id: userId }, { $push: { refreshTokens: sessionEntry } });

  return sessionEntry;
}

/**
 * @param {import('mongoose').Types.ObjectId|string} userId
 * @param {string} presentedHash
 */
async function revokeSessionByTokenHash(userId, presentedHash) {
  if (!presentedHash) return { modifiedCount: 0 };

  await User.updateOne(
    { _id: userId },
    { $pull: { refreshTokens: { token: presentedHash } } }
  );

  return User.updateOne(
    { _id: userId },
    { $pull: { refreshTokens: { previousToken: presentedHash } } }
  );
}

/**
 * @param {import('mongoose').Types.ObjectId|string} userId
 * @param {string} deviceId — refreshTokens subdocument _id
 */
async function revokeSessionByDeviceId(userId, deviceId) {
  if (!deviceId || !mongoose.Types.ObjectId.isValid(deviceId)) {
    return { modifiedCount: 0 };
  }
  return User.updateOne(
    { _id: userId },
    { $pull: { refreshTokens: { _id: new mongoose.Types.ObjectId(deviceId) } } }
  );
}

/** @param {import('mongoose').Types.ObjectId|string} userId */
async function revokeAllSessions(userId) {
  return User.updateOne({ _id: userId }, { $set: { refreshTokens: [] } });
}

/**
 * Read-only session lookup for refresh / logout validation.
 * @param {string} refreshTokenPlain
 * @returns {Promise<{ user: import('mongoose').Document, presentedHash: string, decoded: object, slot: object, matchKind: 'active'|'replay' }|null>}
 */
async function lookupSession(refreshTokenPlain) {
  const decoded = verifyRefreshJwt(refreshTokenPlain);
  if (!decoded) return null;

  const presentedHash = hashRefreshToken(refreshTokenPlain);
  const now = new Date();
  const userId = decoded.id;

  const activeQuery = {
    _id: userId,
    refreshTokens: {
      $elemMatch: {
        token: presentedHash,
        expiresAt: { $gt: now }
      }
    }
  };

  let user = await User.findOne(activeQuery).select(REFRESH_TOKEN_SELECT);
  if (user) {
    const slot = user.refreshTokens.find(
      (t) => t.token === presentedHash && t.expiresAt > now
    );
    if (slot) {
      return { user, presentedHash, decoded, slot, matchKind: 'active' };
    }
  }

  const replayQuery = {
    _id: userId,
    refreshTokens: {
      $elemMatch: {
        previousToken: presentedHash,
        previousTokenValidUntil: { $gt: now },
        expiresAt: { $gt: now }
      }
    }
  };

  user = await User.findOne(replayQuery).select(REFRESH_TOKEN_SELECT);
  if (!user) return null;

  const slot = user.refreshTokens.find(
    (t) =>
      t.previousToken === presentedHash &&
      t.previousTokenValidUntil &&
      new Date(t.previousTokenValidUntil) > now &&
      t.expiresAt > now
  );

  if (!slot) return null;

  return { user, presentedHash, decoded, slot, matchKind: 'replay' };
}

/**
 * Atomically rotate one refresh session (active token only — not replay grace).
 * @returns {Promise<{ rotated: boolean, slot?: object }>}
 */
async function rotateSession(userId, presentedHash, newHashedToken, deviceInfo) {
  if (!presentedHash || !newHashedToken || presentedHash === newHashedToken) {
    return { rotated: false };
  }
  const now = new Date();
  const expiresAt = refreshTokenExpiresAt(now.getTime());
  const graceUntil = rotationGraceUntil(now.getTime());

  const updated = await User.findOneAndUpdate(
    {
      _id: userId,
      refreshTokens: {
        $elemMatch: {
          token: presentedHash,
          expiresAt: { $gt: now }
        }
      }
    },
    {
      $set: {
        'refreshTokens.$.token': newHashedToken,
        'refreshTokens.$.expiresAt': expiresAt,
        'refreshTokens.$.createdAt': now,
        'refreshTokens.$.previousToken': presentedHash,
        'refreshTokens.$.previousTokenValidUntil': graceUntil,
        'refreshTokens.$.deviceInfo': deviceInfo || 'Unknown'
      }
    },
    { returnDocument: 'after' }
  ).select(REFRESH_TOKEN_SELECT);

  if (!updated) {
    return { rotated: false };
  }

  const slot = updated.refreshTokens.find((t) => t.token === newHashedToken);
  return { rotated: true, slot: slot || null };
}

/** @param {import('mongoose').Types.ObjectId|string} userId */
async function listActiveSessions(userId) {
  const user = await User.findById(userId).select('refreshTokens');
  if (!user) return [];
  const now = new Date();
  return user.refreshTokens
    .filter((t) => t.expiresAt > now)
    .map((t) => ({
      deviceId: t._id,
      deviceInfo: t.deviceInfo,
      lastActive: t.createdAt,
      expiresAt: t.expiresAt
    }));
}

module.exports = {
  REFRESH_TOKEN_TTL_MS,
  REFRESH_ROTATION_GRACE_MS,
  hashRefreshToken,
  refreshTokenExpiresAt,
  rotationGraceUntil,
  verifyRefreshJwt,
  appendSession,
  revokeSessionByTokenHash,
  revokeSessionByDeviceId,
  revokeAllSessions,
  lookupSession,
  rotateSession,
  listActiveSessions
};
