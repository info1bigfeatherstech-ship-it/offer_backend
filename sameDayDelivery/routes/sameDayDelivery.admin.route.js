'use strict';

const express = require('express');
const { verifyToken } = require('../../middlewares/auth.middleware');
const { authorizeRoles } = require('../../middlewares/authorize-roles.middleware');
const { requireAdminStorefrontScope } = require('../../middlewares/admin-storefront-scope.middleware');
const {
  getSettings,
  updateSettings,
  getOrdersSummary,
  listOrders,
  getOrder,
  shipOrder,
  cancelOrder,
  previewEdit,
  applyEdit,
} = require('../controllers/sameDayDelivery.admin.controller');

const router = express.Router();

router.use(verifyToken);
router.use(authorizeRoles('admin', 'order_manager'));
router.use(requireAdminStorefrontScope);

router.get('/settings', authorizeRoles('admin'), getSettings);
router.put('/settings', authorizeRoles('admin'), updateSettings);

router.get('/orders/summary', getOrdersSummary);
router.get('/orders', listOrders);
router.get('/orders/:orderId', getOrder);
router.post('/orders/:orderId/ship', shipOrder);
router.post('/orders/:orderId/cancel', cancelOrder);
router.post('/orders/:orderId/edit/preview', previewEdit);
router.post('/orders/:orderId/edit', applyEdit);

module.exports = router;
