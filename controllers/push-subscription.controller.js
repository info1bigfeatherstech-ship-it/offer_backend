const {
  getVapidPublicKey,
  isPushConfigured,
} = require('../services/cartReminderPush.service');
const {
  upsertPushSubscription,
  removePushSubscription,
  getPushStatusForUser,
} = require('../services/pushSubscription.service');
const {
  getPushSoftPromptEligibility,
  recordPushSoftPromptImpression,
} = require('../services/pushSoftPrompt.service');
const { recordPwaInstall } = require('../services/engagementAnalytics.service');
const logger = require('../utils/logger');

const getVapidPublicKeyHandler = async (req, res) => {
  try {
    if (!isPushConfigured()) {
      return res.status(503).json({
        success: false,
        code: 'PUSH_NOT_CONFIGURED',
        message: 'Web push is not enabled on this server',
        configured: false,
      });
    }

    return res.status(200).json({
      success: true,
      configured: true,
      publicKey: getVapidPublicKey(),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Could not load push configuration',
    });
  }
};

const subscribePush = async (req, res) => {
  try {
    if (!isPushConfigured()) {
      return res.status(503).json({
        success: false,
        code: 'PUSH_NOT_CONFIGURED',
        message: 'Web push is not enabled on this server',
      });
    }

    const userId = req.user?._id || req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required',
      });
    }

    const doc = await upsertPushSubscription({
      userId,
      subscription: req.body,
      userAgent: req.headers['user-agent'],
    });

    return res.status(200).json({
      success: true,
      message: 'Push subscription saved',
      subscriptionId: doc._id,
    });
  } catch (error) {
    const code = error.code || 'SUBSCRIBE_FAILED';
    const status = ['INVALID_SUBSCRIPTION', 'UNTRUSTED_ENDPOINT'].includes(code) ? 400 : 500;
    return res.status(status).json({
      success: false,
      code,
      message: error.message || 'Could not save push subscription',
    });
  }
};

const unsubscribePush = async (req, res) => {
  try {
    const userId = req.user?._id || req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required',
      });
    }

    const endpoint = req.body?.endpoint;
    const result = await removePushSubscription({ userId, endpoint });

    return res.status(200).json({
      success: true,
      deleted: result.deleted,
    });
  } catch (error) {
    const code = error.code || 'UNSUBSCRIBE_FAILED';
    const status = code === 'ENDPOINT_REQUIRED' ? 400 : 500;
    return res.status(status).json({
      success: false,
      code,
      message: error.message || 'Could not remove push subscription',
    });
  }
};

const getPushStatus = async (req, res) => {
  try {
    const userId = req.user?._id || req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required',
      });
    }

    const status = await getPushStatusForUser(userId);

    return res.status(200).json({
      success: true,
      configured: isPushConfigured(),
      ...status,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Could not load push status',
    });
  }
};

const getPushPromptEligibilityHandler = async (req, res) => {
  try {
    const userId = req.user?._id || req.user?.id || req.userId;
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required',
      });
    }

    const eligibility = await getPushSoftPromptEligibility(userId);

    return res.status(200).json({
      success: true,
      ...eligibility,
    });
  } catch (error) {
    const code = error.code || 'PROMPT_ELIGIBILITY_FAILED';
    const status = code === 'USER_NOT_FOUND' ? 404 : 500;
    return res.status(status).json({
      success: false,
      code,
      message: error.message || 'Could not check push prompt eligibility',
      allowed: false,
    });
  }
};

const recordPushPromptImpressionHandler = async (req, res) => {
  try {
    const userId = req.user?._id || req.user?.id || req.userId;
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required',
      });
    }

    const result = await recordPushSoftPromptImpression(userId);

    return res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    const code = error.code || 'PROMPT_IMPRESSION_FAILED';
    const status = code === 'USER_NOT_FOUND' ? 404 : 500;
    return res.status(status).json({
      success: false,
      code,
      message: error.message || 'Could not record push prompt impression',
      recorded: false,
    });
  }
};

/**
 * Logged-in PWA install attribution (appinstalled or standalone confirm).
 * Idempotent — safe to call on every standalone session open.
 */
const recordPwaInstallHandler = async (req, res) => {
  try {
    const userId = req.user?._id || req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required',
      });
    }

    const result = await recordPwaInstall(userId, {
      userAgent: req.headers['user-agent'] || null,
    });

    return res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    const code = error.code || 'PWA_INSTALL_FAILED';
    const status = code === 'USER_NOT_FOUND' ? 404 : 500;
    logger.warn('[pwaInstall] record failed', {
      code,
      message: error?.message,
    });
    return res.status(status).json({
      success: false,
      code,
      message: error.message || 'Could not record PWA install',
    });
  }
};

module.exports = {
  getVapidPublicKeyHandler,
  subscribePush,
  unsubscribePush,
  getPushStatus,
  getPushPromptEligibilityHandler,
  recordPushPromptImpressionHandler,
  recordPwaInstallHandler,
};
