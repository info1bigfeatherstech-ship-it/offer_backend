const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/auth.middleware');
const { authorizeRoles } = require('../middlewares/authorize-roles.middleware');
const { requireAdminStorefrontScope } = require('../middlewares/admin-storefront-scope.middleware');
const { quoteCheckout, confirmCheckout } = require('../controllers/checkout.controller');
const checkoutSettingsController = require('../controllers/checkout-settings.controller');
const {
  requireWholesaleUserForWholesaleStorefront
} = require('../middlewares/storefront.middleware');

router.get('/settings', verifyToken, requireWholesaleUserForWholesaleStorefront, checkoutSettingsController.getUserCheckoutSettings);
router.post('/quote', verifyToken, requireWholesaleUserForWholesaleStorefront, quoteCheckout);
router.post('/confirm', verifyToken, requireWholesaleUserForWholesaleStorefront, confirmCheckout);

router.get(
  '/admin/settings',
  verifyToken,
  authorizeRoles('admin'),
  requireAdminStorefrontScope,
  checkoutSettingsController.getAdminCheckoutSettings
);
router.put(
  '/admin/settings',
  verifyToken,
  authorizeRoles('admin'),
  requireAdminStorefrontScope,
  checkoutSettingsController.updateAdminCheckoutSettings
);

module.exports = router;
