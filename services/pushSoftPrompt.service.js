const User = require('../models/User');

/**
 * Soft prompt is shown on every visit until the browser grants notifications.
 * Cadence / impression caps were removed by product request.
 * Endpoints kept for backward compatibility with older clients.
 */

async function getPushSoftPromptEligibility(userId) {
  if (!userId) {
    const err = new Error('userId is required');
    err.code = 'USER_REQUIRED';
    throw err;
  }

  const user = await User.findById(userId).select('_id').lean();
  if (!user) {
    const err = new Error('User not found');
    err.code = 'USER_NOT_FOUND';
    throw err;
  }

  return {
    allowed: true,
    reason: 'ok',
    remaining: null,
    count: 0,
    lastShownAt: null,
    nextEligibleAt: null,
  };
}

async function recordPushSoftPromptImpression(userId) {
  if (!userId) {
    const err = new Error('userId is required');
    err.code = 'USER_REQUIRED';
    throw err;
  }

  const user = await User.findById(userId).select('_id').lean();
  if (!user) {
    const err = new Error('User not found');
    err.code = 'USER_NOT_FOUND';
    throw err;
  }

  return {
    recorded: true,
    reason: 'noop',
    allowed: true,
    remaining: null,
    count: 0,
    lastShownAt: null,
    nextEligibleAt: null,
  };
}

function evaluateCadence() {
  return {
    allowed: true,
    reason: 'ok',
    remaining: null,
    count: 0,
    lastShownAt: null,
    nextEligibleAt: null,
  };
}

module.exports = {
  WINDOW_MS: 0,
  MAX_SHOWS_IN_WINDOW: null,
  MIN_GAP_MS: 0,
  evaluateCadence,
  getPushSoftPromptEligibility,
  recordPushSoftPromptImpression,
};
