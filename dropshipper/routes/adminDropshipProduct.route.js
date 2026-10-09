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

const readRoles = authorizeRoles('admin', 'product_manager', 'inventory_manager');
const writeRoles = authorizeRoles('admin', 'product_manager');
const orderReadRoles = authorizeRoles(
  'admin',
  'order_manager',
  'product_manager',
  'inventory_manager'
);

router.use(verifyToken);

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
