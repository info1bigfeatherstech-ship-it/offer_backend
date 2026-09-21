/**
 * Admin order dashboard & list — {@link ../controllers/admin-orders.controller.js}
 */
const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/auth.middleware');
const { authorizeRoles } = require('../middlewares/authorize-roles.middleware');
const { requireStrictAdminStorefrontScope } = require('../middlewares/admin-storefront-scope.middleware');
const adminOrdersController = require('../controllers/admin-orders.controller');
const {
  ORDER_READ_ROLES,
  ORDER_WRITE_ROLES
} = require('../utils/adminOrderRoles');

router.use(verifyToken);
router.use(authorizeRoles(...ORDER_READ_ROLES));
router.use(requireStrictAdminStorefrontScope);

router.get('/summary', adminOrdersController.getDashboardSummary);
router.get('/', adminOrdersController.getOrdersList);

/** Side-effecting sync — packing_viewer cannot run this. */
router.post(
  '/auto-sync-statuses',
  authorizeRoles(...ORDER_WRITE_ROLES),
  adminOrdersController.autoSyncOrderStatuses
);

module.exports = router;
