'use strict';

/**
 * Admin dropshipper product routes — separate from /api/admin/products.
 * Mount: /api/admin/dropshipper
 *
 * Auth: same product write roles as catalog managers.
 * Does not alter ecomm/wholesale product CRUD routes.
 */

const express = require('express');
const router = express.Router();
const { verifyToken } = require('../../middlewares/auth.middleware');
const { authorizeRoles } = require('../../middlewares/authorize-roles.middleware');
const controller = require('../controllers/adminDropshipProduct.controller');
const orderController = require('../controllers/adminDropshipOrder.controller');
const accountController = require('../controllers/adminAccount.controller');

const readRoles = authorizeRoles('admin', 'product_manager', 'inventory_manager');
const writeRoles = authorizeRoles('admin', 'product_manager');
const orderReadRoles = authorizeRoles(
  'admin',
  'order_manager',
  'product_manager',
  'inventory_manager'
);

router.use(verifyToken);

const accountReadRoles = authorizeRoles('admin', 'order_manager', 'product_manager');
const adminWrite = authorizeRoles('admin');

// Subscription settings (fee + registration open). Years stay hardcoded at 1.
router.get('/settings', accountReadRoles, accountController.getSettings);
router.patch('/settings', adminWrite, accountController.updateSettings);

// Registration review
router.get('/requests', accountReadRoles, accountController.listRequests);
router.get('/requests/:id', accountReadRoles, accountController.getRequest);
router.post('/requests/:id/approve', adminWrite, accountController.approveRequest);
router.post('/requests/:id/reject', adminWrite, accountController.rejectRequest);

// Activated partner accounts
router.get('/accounts', accountReadRoles, accountController.listAccounts);
router.get('/accounts/:id', accountReadRoles, accountController.getAccount);

// Dropship orders (dedicated list — does not alter ecomm/wholesale order panels)
router.get('/orders', orderReadRoles, orderController.listOrders);
router.get('/orders/:orderId', orderReadRoles, orderController.getOrder);

// Lists first (before :slug)
router.get('/products', readRoles, controller.listDropshipProducts);
router.post('/products/bulk-enable', writeRoles, controller.bulkEnableDropship);
router.post('/products/bulk-set-price', writeRoles, controller.bulkSetDropshipPrice);

router.get('/products/:slug', readRoles, controller.getDropshipProduct);

router.patch(
  '/products/:slug/variants/:productCode/price',
  writeRoles,
  controller.setDropshipPrice
);
router.patch(
  '/products/:slug/variants/:productCode/enable',
  writeRoles,
  controller.enableDropship
);
router.patch(
  '/products/:slug/variants/:productCode/disable',
  writeRoles,
  controller.disableDropship
);

module.exports = router;
