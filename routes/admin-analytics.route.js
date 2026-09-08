// routes/adminAnalyticsRoutes.js
const express = require('express');
const router = express.Router();
const {
  getAllUsers,
  exportUsersExcel,
  getUserById,
  bulkCartReminderEmail,
  bulkCartReminderPush,
  bulkWishlistReminderPush,
  getLeadsPushSettings,
  updateLeadsPushSettings,
  getAllCarts,
  getAbandonedCarts,
  getHighValueCarts,
  getCartById,
  getAllWishlists,
  getStaleWishlists,
  getPopularWishlistProducts,
  getDashboardSummary,
  getEngagementSummary,
  getPushSubscribers,
  getPwaInstalls,
} = require('../controllers/admin-analytics.controller');

// Import your auth middleware (adjust path as needed)
// const { protect, authorize } = require('../middleware/authMiddleware');

//auth middleware 
const { verifyToken } = require('../middlewares/auth.middleware');
const { authorizeRoles } = require('../middlewares/authorize-roles.middleware');
const { requireStrictAdminStorefrontScope } = require('../middlewares/admin-storefront-scope.middleware');

// All routes require authentication and admin/marketing role
router.use(verifyToken);
router.use(authorizeRoles('admin', 'marketing_manager'));
router.use(requireStrictAdminStorefrontScope);

// User analytics
router.get('/users', getAllUsers);
router.get('/users/export', exportUsersExcel);
router.get('/push-settings', getLeadsPushSettings);
router.put('/push-settings', updateLeadsPushSettings);
router.get('/engagement/summary', getEngagementSummary);
router.get('/engagement/push-subscribers', getPushSubscribers);
router.get('/engagement/pwa-installs', getPwaInstalls);
router.post('/users/bulk-cart-reminder-email', bulkCartReminderEmail);
router.post('/users/bulk-cart-reminder-push', bulkCartReminderPush);
router.post('/users/bulk-wishlist-reminder-push', bulkWishlistReminderPush);
router.get('/users/:userId', getUserById);

// Cart analytics
router.get('/carts', getAllCarts);
router.get('/carts/abandoned', getAbandonedCarts);
router.get('/carts/high-value', getHighValueCarts);
router.get('/carts/:cartId', getCartById);

// Wishlist analytics
router.get('/wishlists', getAllWishlists);
router.get('/wishlists/stale', getStaleWishlists);
router.get('/wishlists/popular-products', getPopularWishlistProducts);

// Dashboard summary
router.get('/dashboard/summary', getDashboardSummary);

module.exports = router;