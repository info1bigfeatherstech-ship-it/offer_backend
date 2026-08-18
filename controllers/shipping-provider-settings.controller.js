const shippingProviderSettingsService = require('../services/shippingProviderSettings.service');
const shipmozoLabelSettingsService = require('../services/shipmozoLabelSettings.service');
const { buildSampleViewModel, resolvePickupWarehouse } = require('../services/shipmozoLabelViewModel.service');
const { renderLabelHtml } = require('../services/shipmozoLabelPdf.service');
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

function resolveSettingsStorefront(req) {
  if (req.adminScope?.storefront === 'wholesale' || req.adminScope?.storefront === 'ecomm') {
    return req.adminScope.storefront;
  }
  return req.storefront === 'wholesale' ? 'wholesale' : 'ecomm';
}

/**
 * GET /api/shipping-provider/admin/shipmozo-label-settings
 * Storefront-scoped: ecomm panel ↔ ecomm settings, wholesale panel ↔ wholesale settings.
 */
exports.getShipmozoLabelSettings = async (req, res) => {
  try {
    const storefront = resolveSettingsStorefront(req);
    const data = await shipmozoLabelSettingsService.getPublicSettings(storefront);
    const pickup = await resolvePickupWarehouse(storefront, data.settings?.pickup?.sellerName);
    data.pickupIdentity = {
      name: pickup?.name || '',
      source: pickup?.source || 'env'
    };
    return res.json({ success: true, data });
  } catch (error) {
    logger.error('getShipmozoLabelSettings failed', buildRequestLogContext(req, { message: error.message }));
    return jsonError(res, 500, 'SHIPMOZO_LABEL_SETTINGS_FETCH_FAILED', error.message || 'Server error');
  }
};

/**
 * PUT /api/shipping-provider/admin/shipmozo-label-settings
 */
exports.updateShipmozoLabelSettings = async (req, res) => {
  try {
    const storefront = resolveSettingsStorefront(req);
    const patch = req.body?.settings && typeof req.body.settings === 'object' ? req.body.settings : req.body;
    const data = await shipmozoLabelSettingsService.saveSettings(storefront, patch, req.userId || null);
    const pickup = await resolvePickupWarehouse(storefront, data.settings?.pickup?.sellerName);
    data.pickupIdentity = {
      name: pickup?.name || '',
      source: pickup?.source || 'env'
    };
    return res.json({
      success: true,
      message: 'Shipmozo label settings saved for this storefront',
      data
    });
  } catch (error) {
    logger.error('updateShipmozoLabelSettings failed', buildRequestLogContext(req, { message: error.message }));
    return jsonError(res, 500, 'SHIPMOZO_LABEL_SETTINGS_UPDATE_FAILED', error.message || 'Server error');
  }
};

/**
 * POST /api/shipping-provider/admin/shipmozo-label-settings/preview
 * Live 4×6 HTML preview from draft (unsaved) or saved settings. Never touches Shiprocket.
 */
exports.previewShipmozoLabelSettings = async (req, res) => {
  try {
    const storefront = resolveSettingsStorefront(req);
    const draft = req.body?.settings && typeof req.body.settings === 'object' ? req.body.settings : req.body;
    const saved = await shipmozoLabelSettingsService.getPublicSettings(storefront);
    const settings = shipmozoLabelSettingsService.sanitizeSettings(
      draft && Object.keys(draft || {}).length ? draft : saved.settings
    );
    const vm = buildSampleViewModel(settings, storefront);
    try {
      const pickup = await resolvePickupWarehouse(storefront, settings.pickup?.sellerName);
      if (pickup?.name) {
        vm.pickup = { ...vm.pickup, ...pickup };
        vm.rto = vm.pickup;
      }
    } catch {
      /* keep sample pickup */
    }
    const html = await renderLabelHtml(vm);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Storefront', storefront);
    return res.status(200).send(html);
  } catch (error) {
    logger.error('previewShipmozoLabelSettings failed', { message: error.message });
    return jsonError(res, 500, 'SHIPMOZO_LABEL_PREVIEW_FAILED', error.message || 'Preview failed');
  }
};
