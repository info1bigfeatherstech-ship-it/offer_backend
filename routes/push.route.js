const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/auth.middleware');
const { limiters } = require('../middlewares/rate-limiter.middleware');
const {
  getVapidPublicKeyHandler,
  subscribePush,
  unsubscribePush,
  getPushStatus,
  getPushPromptEligibilityHandler,
  recordPushPromptImpressionHandler,
} = require('../controllers/push-subscription.controller');

/**
 * Rate limits sit AFTER verifyToken on authed routes so the bucket key is
 * per userId (not shared NAT/IP). Public vapid uses pushRead by IP.
 * Do not remount a blanket /api/push limiter in server.js — that would
 * double-count and force IP buckets before auth.
 */

router.get('/vapid-public-key', limiters.pushRead, getVapidPublicKeyHandler);

router.get('/status', verifyToken, limiters.pushRead, getPushStatus);
router.get(
  '/prompt-eligibility',
  verifyToken,
  limiters.pushRead,
  getPushPromptEligibilityHandler
);

router.post(
  '/prompt-impression',
  verifyToken,
  limiters.pushWrite,
  recordPushPromptImpressionHandler
);
router.post('/subscribe', verifyToken, limiters.pushWrite, subscribePush);
router.delete('/unsubscribe', verifyToken, limiters.pushWrite, unsubscribePush);

module.exports = router;
