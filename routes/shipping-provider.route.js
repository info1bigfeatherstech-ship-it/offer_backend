const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/auth.middleware');
const { authorizeRoles } = require('../middlewares/authorize-roles.middleware');
const shippingProviderSettingsController = require('../controllers/shipping-provider-settings.controller');

/** Admin + order_manager may view/update active partner + warehouse/pin (keys stay in env). */
const shippingSettingsStaff = [verifyToken, authorizeRoles('admin', 'order_manager')];

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

module.exports = router;
