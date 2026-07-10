const express = require('express');
const router = express.Router();
const analyticsController = require('../controllers/seo-analytics.controller');

const { verifyToken } = require('../middlewares/auth.middleware');
const { authorizeRoles } = require('../middlewares/authorize-roles.middleware');
const { requireStrictAdminStorefrontScope } = require('../middlewares/admin-storefront-scope.middleware');

// Isolated from /api/admin/analytics (carts/users). Auth matches other admin analytics.
router.use(verifyToken);
router.use(authorizeRoles('admin', 'marketing_manager'));
router.use(requireStrictAdminStorefrontScope);

router.get('/overview', analyticsController.getOverview);
router.get('/traffic', analyticsController.getTraffic);
router.get('/devices', analyticsController.getDevices);
router.get('/sources', analyticsController.getSources);
router.get('/locations', analyticsController.getLocations);

module.exports = router;
