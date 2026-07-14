/**
 * Admin RTO management routes — isolated from /api/admin/orders.
 */
const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/auth.middleware');
const { authorizeRoles } = require('../middlewares/authorize-roles.middleware');
const { requireStrictAdminStorefrontScope } = require('../middlewares/admin-storefront-scope.middleware');
const adminRtoController = require('../controllers/admin-rto.controller');

router.use(verifyToken);
router.use(authorizeRoles('admin', 'order_manager'));
router.use(requireStrictAdminStorefrontScope);

router.get('/orders', adminRtoController.getRtoOrders);
router.get('/analytics', adminRtoController.getRtoAnalytics);
router.get('/report', adminRtoController.exportRtoReport);
router.post('/auto-sync-statuses', adminRtoController.autoSyncRtoStatuses);
router.post('/refund', adminRtoController.processRtoRefund);
router.post('/reject', adminRtoController.rejectRtoRefund);
router.post('/resolve', adminRtoController.rejectRtoRefund);
router.post('/bulk-action', adminRtoController.bulkRtoAction);

module.exports = router;
