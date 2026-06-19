/**
 * Admin order dashboard & list — {@link ../controllers/admin-orders.controller.js}
 */
const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/auth.middleware');
const { authorizeRoles } = require('../middlewares/authorize-roles.middleware');
const { requireStrictAdminStorefrontScope } = require('../middlewares/admin-storefront-scope.middleware');
const adminOrdersController = require('../controllers/admin-orders.controller');

router.use(verifyToken);
router.use(authorizeRoles('admin', 'order_manager'));
router.use(requireStrictAdminStorefrontScope);

router.get('/summary', adminOrdersController.getDashboardSummary);
router.post('/auto-sync-statuses', adminOrdersController.autoSyncOrderStatuses);
router.get('/', adminOrdersController.getOrdersList);

module.exports = router;
