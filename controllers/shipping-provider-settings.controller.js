const shippingProviderSettingsService = require('../services/shippingProviderSettings.service');
const ShipmozoService = require('../utils/shipmozo');
const logger = require('../utils/logger');
const { buildRequestLogContext } = require('../utils/checkoutFlow');

function jsonError(res, status, code, message, extra = {}) {
  return res.status(status).json({
    success: false,
    code,
    message,
    ...extra
  });
}

/**
 * GET /api/shipping-provider/admin/settings
 */
exports.getAdminShippingProviderSettings = async (req, res) => {
  try {
    const storefront = req.adminScope?.storefront || req.storefront || 'ecomm';
    const config = await shippingProviderSettingsService.getPublicConfig(storefront);
    return res.json({ success: true, data: config });
  } catch (error) {
    logger.error(
      'getAdminShippingProviderSettings failed',
      buildRequestLogContext(req, { message: error.message })
    );
    return jsonError(res, 500, 'SHIPPING_SETTINGS_FETCH_FAILED', error.message || 'Server error');
  }
};

/**
 * PUT /api/shipping-provider/admin/settings
 */
exports.updateAdminShippingProviderSettings = async (req, res) => {
  try {
    const storefront = req.adminScope?.storefront || req.storefront || 'ecomm';
    const result = await shippingProviderSettingsService.applyAdminPatch(
      req.body || {},
      req.userId || null,
      storefront
    );
    if (!result.ok) {
      return jsonError(res, 400, 'SHIPPING_SETTINGS_INVALID', result.errors?.[0] || 'Invalid settings', {
        errors: result.errors || [],
        missing: result.missing || undefined
      });
    }
    return res.json({
      success: true,
      message: 'Shipping provider settings updated',
      data: result.config
    });
  } catch (error) {
    logger.error(
      'updateAdminShippingProviderSettings failed',
      buildRequestLogContext(req, { message: error.message })
    );
    return jsonError(res, 500, 'SHIPPING_SETTINGS_UPDATE_FAILED', error.message || 'Server error');
  }
};

/**
 * GET /api/shipping-provider/admin/shipmozo/warehouses
 */
exports.listShipmozoWarehouses = async (req, res) => {
  try {
    const result = await ShipmozoService.getWarehouses();
    if (!result.success) {
      return jsonError(res, 502, 'SHIPMOZO_WAREHOUSES_FAILED', result.message || 'Failed to list warehouses');
    }
    return res.json({ success: true, warehouses: result.warehouses || [] });
  } catch (error) {
    logger.error('listShipmozoWarehouses failed', { message: error.message });
    return jsonError(res, 500, 'SHIPMOZO_WAREHOUSES_FAILED', error.message || 'Server error');
  }
};

/**
 * POST /api/shipping-provider/admin/shipmozo/test
 * Lightweight connectivity check (info API).
 */
exports.testShipmozoConnection = async (req, res) => {
  try {
    const storefront = req.adminScope?.storefront || req.storefront || 'ecomm';
    const configured = await ShipmozoService.isConfigured(storefront);
    if (!configured) {
      return jsonError(
        res,
        400,
        'SHIPMOZO_NOT_CONFIGURED',
        'Configure publicKey, privateKey, warehouseId, and pickupPincode first'
      );
    }
    const info = await ShipmozoService.info();
    return res.json({
      success: info.ok,
      message: info.message,
      data: info.data || null
    });
  } catch (error) {
    logger.error('testShipmozoConnection failed', { message: error.message });
    return jsonError(res, 500, 'SHIPMOZO_TEST_FAILED', error.message || 'Server error');
  }
};
