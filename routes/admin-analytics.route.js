// routes/adminAnalyticsRoutes.js
const express = require('express');
const router = express.Router();
const {
  getAllUsers,
  getUserById,
  bulkCartReminderEmail,
  bulkCartReminderPush,
  getLeadsPushSettings,
  updateLeadsPushSettings,
  getAllCarts,
  getAbandonedCarts,
  getHighValueCarts,
  getCartById,
  getAllWishlists,
  getStaleWishlists,
  getPopularWishlistProducts,
  getDashboardSummary
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
router.get('/push-settings', getLeadsPushSettings);
router.put('/push-settings', updateLeadsPushSettings);
router.post('/users/bulk-cart-reminder-email', bulkCartReminderEmail);
router.post('/users/bulk-cart-reminder-push', bulkCartReminderPush);
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