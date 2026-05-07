const checkoutSettingsService = require('../services/checkoutSettings.service');
const logger = require('../utils/logger');
const { buildRequestLogContext } = require('../utils/checkoutFlow');

/**
 * GET /api/checkout/settings
 * Authenticated shoppers: policy for current storefront (COD / partial visibility & percent).
 */
exports.getUserCheckoutSettings = async (req, res) => {
  try {
    const storefront = checkoutSettingsService.normalizeStorefront(req.storefront);
    const policy = await checkoutSettingsService.getPolicyForStorefront(storefront);
    return res.json({
      success: true,
      data: policy
    });
  } catch (err) {
    logger.error('getUserCheckoutSettings failed', buildRequestLogContext(req, {
      message: err.message,
      stack: err.stack
    }));
    return res.status(500).json({
      success: false,
      code: 'CHECKOUT_SETTINGS_FETCH_FAILED',
      message: 'Could not load checkout settings'
    });
  }
};

/**
 * GET /api/checkout/admin/settings
 * Admin: read policy for scoped storefront.
 */
exports.getAdminCheckoutSettings = async (req, res) => {
  try {
    const storefront = checkoutSettingsService.normalizeStorefront(
      req.adminScope?.storefront || req.storefront
    );
    const policy = await checkoutSettingsService.getPolicyForStorefront(storefront);
    return res.json({
      success: true,
      data: policy
    });
  } catch (err) {
    logger.error('getAdminCheckoutSettings failed', buildRequestLogContext(req, {
      message: err.message
    }));
    return res.status(500).json({
      success: false,
      code: 'CHECKOUT_SETTINGS_FETCH_FAILED',
      message: 'Could not load checkout settings'
    });
  }
};

/**
 * PUT /api/checkout/admin/settings
 * Admin: update COD / partial policy for scoped storefront.
 */
exports.updateAdminCheckoutSettings = async (req, res) => {
  try {
    const storefront = checkoutSettingsService.normalizeStorefront(
      req.adminScope?.storefront || req.storefront
    );
    const result = await checkoutSettingsService.applyAdminPatch(
      storefront,
      req.body || {},
      req.userId || null
    );

    if (!result.ok) {
      return res.status(400).json({
        success: false,
        code: 'CHECKOUT_SETTINGS_VALIDATION_FAILED',
        message: result.errors.join(' '),
        errors: result.errors
      });
    }

    logger.info('Checkout settings updated', buildRequestLogContext(req, {
      storefront,
      policy: result.policy
    }));

    return res.json({
      success: true,
      message: 'Checkout settings updated',
      data: result.policy
    });
  } catch (err) {
    const status = err.statusCode && Number.isFinite(err.statusCode) ? err.statusCode : 500;
    logger.error('updateAdminCheckoutSettings failed', buildRequestLogContext(req, {
      message: err.message,
      stack: err.stack
    }));
    return res.status(status).json({
      success: false,
      code: err.code || 'CHECKOUT_SETTINGS_UPDATE_FAILED',
      message: status === 500 ? 'Could not update checkout settings' : err.message
    });
  }
};
