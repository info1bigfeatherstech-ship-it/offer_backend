const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/auth.middleware');
const { authorizeRoles } = require('../middlewares/authorize-roles.middleware');
const { requireAdminStorefrontScope } = require('../middlewares/admin-storefront-scope.middleware');
const shippingProviderSettingsController = require('../controllers/shipping-provider-settings.controller');
const { uploadLabelLogoFile } = require('../middlewares/upload.middleware');

/** Admin + order_manager may view/update active partner + warehouse/pin (keys stay in env). */
const shippingSettingsStaff = [verifyToken, authorizeRoles('admin', 'order_manager')];
const storefrontScopedStaff = [...shippingSettingsStaff, requireAdminStorefrontScope];

router.get(
  '/admin/settings',
  ...shippingSettingsStaff,
  shippingProviderSettingsController.getAdminShippingProviderSettings
);

router.put(
  '/admin/settings',
  ...shippingSettingsStaff,
  shippingProviderSettingsController.updateAdminShippingProviderSettings
);

router.get(
  '/admin/shipmozo/warehouses',
  ...shippingSettingsStaff,
  shippingProviderSettingsController.listShipmozoWarehouses
);

router.post(
  '/admin/shipmozo/test',
  ...shippingSettingsStaff,
  shippingProviderSettingsController.testShipmozoConnection
);

router.get(
  '/admin/shipmozo-label-settings',
  ...storefrontScopedStaff,
  shippingProviderSettingsController.getShipmozoLabelSettings
);

router.put(
  '/admin/shipmozo-label-settings',
  ...storefrontScopedStaff,
  shippingProviderSettingsController.updateShipmozoLabelSettings
);

router.post(
  '/admin/shipmozo-label-settings/preview',
  ...storefrontScopedStaff,
  shippingProviderSettingsController.previewShipmozoLabelSettings
);

router.post(
  '/admin/shipmozo-label-settings/logo',
  ...storefrontScopedStaff,
  uploadLabelLogoFile,
  shippingProviderSettingsController.uploadShipmozoLabelLogo
);

router.delete(
  '/admin/shipmozo-label-settings/logo',
  ...storefrontScopedStaff,
  shippingProviderSettingsController.removeShipmozoLabelLogo
);

module.exports = router;
