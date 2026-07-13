/**
 * Admin out-of-stock inquiry list / status updates.
 */
const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/auth.middleware');
const { authorizeRoles } = require('../middlewares/authorize-roles.middleware');
const { requireStrictAdminStorefrontScope } = require('../middlewares/admin-storefront-scope.middleware');
const {
  listOutOfStockInquiries,
  updateOutOfStockInquiryStatus,
} = require('../controllers/out-of-stock-inquiry.controller');

router.use(verifyToken);
router.use(authorizeRoles('admin', 'marketing_manager', 'product_manager'));
router.use(requireStrictAdminStorefrontScope);

router.get('/', listOutOfStockInquiries);
router.patch('/:id/status', updateOutOfStockInquiryStatus);

module.exports = router;
