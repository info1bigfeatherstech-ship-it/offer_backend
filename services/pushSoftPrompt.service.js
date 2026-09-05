const User = require('../models/User');
const logger = require('../utils/logger');

/** Soft UI cadence: max N shows in a rolling window, with a minimum gap. */
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SHOWS_IN_WINDOW = 4;
const MIN_GAP_MS = 42 * 60 * 60 * 1000;
/** Keep a small buffer beyond the window for pruning. */
const MAX_STORED_IMPRESSIONS = 12;

function pruneImpressions(impressions, now = Date.now()) {
  const cutoff = now - WINDOW_MS;
  const list = Array.isArray(impressions) ? impressions : [];
  return list
    .map((d) => (d instanceof Date ? d : new Date(d)))
    .filter((d) => !Number.isNaN(d.getTime()) && d.getTime() >= cutoff)
    .sort((a, b) => a.getTime() - b.getTime())
    .slice(-MAX_STORED_IMPRESSIONS);
}

function evaluateCadence(impressions, now = Date.now()) {
  const recent = pruneImpressions(impressions, now);
  const count = recent.length;
  const last = count > 0 ? recent[count - 1] : null;
  const lastMs = last ? last.getTime() : null;

  if (count >= MAX_SHOWS_IN_WINDOW) {
    const oldestInWindow = recent[0].getTime();
    const nextEligibleAt = new Date(oldestInWindow + WINDOW_MS);
    return {
      allowed: false,
      reason: 'max_shows_in_window',
      remaining: 0,
      count,
      lastShownAt: last,
      nextEligibleAt,
      windowMs: WINDOW_MS,
      maxShows: MAX_SHOWS_IN_WINDOW,
      minGapMs: MIN_GAP_MS,
    };
  }

  if (lastMs != null && now - lastMs < MIN_GAP_MS) {
    return {
      allowed: false,
      reason: 'min_gap',
      remaining: Math.max(0, MAX_SHOWS_IN_WINDOW - count),
      count,
      lastShownAt: last,
      nextEligibleAt: new Date(lastMs + MIN_GAP_MS),
      windowMs: WINDOW_MS,
      maxShows: MAX_SHOWS_IN_WINDOW,
      minGapMs: MIN_GAP_MS,
    };
  }

  return {
    allowed: true,
    reason: 'ok',
    remaining: Math.max(0, MAX_SHOWS_IN_WINDOW - count),
    count,
    lastShownAt: last,
    nextEligibleAt: null,
    windowMs: WINDOW_MS,
    maxShows: MAX_SHOWS_IN_WINDOW,
    minGapMs: MIN_GAP_MS,
  };
}

/**
 * Read-only eligibility for logged-in soft push prompt.
 */
async function getPushSoftPromptEligibility(userId) {
  if (!userId) {
    const err = new Error('userId is required');
    err.code = 'USER_REQUIRED';
    throw err;
  }

  const user = await User.findById(userId)
    .select('pushSoftPrompt')
    .lean();

  if (!user) {
    const err = new Error('User not found');
    err.code = 'USER_NOT_FOUND';
    throw err;
  }

  const impressions = user.pushSoftPrompt?.impressions || [];
  return evaluateCadence(impressions);
}

/**
 * Record one soft-prompt impression. Idempotent within MIN_GAP (returns recorded:false).
 */
async function recordPushSoftPromptImpression(userId) {
  if (!userId) {
    const err = new Error('userId is required');
    err.code = 'USER_REQUIRED';
    throw err;
  }

  const now = new Date();
  const nowMs = now.getTime();
  const gapCutoff = new Date(nowMs - MIN_GAP_MS);

  // Atomic-ish: skip if lastShownAt is within min gap (covers double-tab race).
  const updated = await User.findOneAndUpdate(
    {
      _id: userId,
      $or: [
        { 'pushSoftPrompt.lastShownAt': { $exists: false } },
        { 'pushSoftPrompt.lastShownAt': null },
        { 'pushSoftPrompt.lastShownAt': { $lte: gapCutoff } },
      ],
    },
    {
      $set: { 'pushSoftPrompt.lastShownAt': now },
      $push: {
        'pushSoftPrompt.impressions': {
          $each: [now],
          $slice: -MAX_STORED_IMPRESSIONS,
        },
      },
    },
    { new: true, select: 'pushSoftPrompt' }
  );

  if (!updated) {
    const existing = await User.findById(userId).select('pushSoftPrompt').lean();
    if (!existing) {
      const err = new Error('User not found');
      err.code = 'USER_NOT_FOUND';
      throw err;
    }
    const cadence = evaluateCadence(existing.pushSoftPrompt?.impressions || [], nowMs);
    return {
      recorded: false,
      reason: cadence.allowed ? 'concurrent_or_recent' : cadence.reason,
      ...cadence,
      allowed: false,
    };
  }

  // Opportunistic prune of impressions older than the window (best-effort).
  try {
    const pruned = pruneImpressions(updated.pushSoftPrompt?.impressions || [], nowMs);
    const rawLen = (updated.pushSoftPrompt?.impressions || []).length;
    if (pruned.length < rawLen) {
      await User.updateOne(
        { _id: userId },
        { $set: { 'pushSoftPrompt.impressions': pruned } }
      );
    }
  } catch (pruneErr) {
    logger.warn('[pushSoftPrompt] prune failed (non-fatal)', {
      userId: String(userId),
      message: pruneErr?.message,
    });
  }

  const cadence = evaluateCadence(updated.pushSoftPrompt?.impressions || [], nowMs);
  return {
    recorded: true,
    reason: 'recorded',
    ...cadence,
    // After recording, further shows are blocked by min gap.
    allowed: false,
  };
}

module.exports = {
  WINDOW_MS,
  MAX_SHOWS_IN_WINDOW,
  MIN_GAP_MS,
  evaluateCadence,
  getPushSoftPromptEligibility,
  recordPushSoftPromptImpression,
};
