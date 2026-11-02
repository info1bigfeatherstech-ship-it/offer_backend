/**
 * Admin corporate / customise-gift enquiry inbox.
 */

const express = require('express');
const { verifyToken } = require('../middlewares/auth.middleware');
const { authorizeRoles } = require('../middlewares/authorize-roles.middleware');
const { requireStrictAdminStorefrontScope } = require('../middlewares/admin-storefront-scope.middleware');
const {
  listCorporateGiftEnquiries,
  getCorporateGiftEnquiry,
  updateCorporateGiftEnquiryStatus,
} = require('../controllers/corporate-gift-enquiry.controller');

const router = express.Router();

router.use(verifyToken);
router.use(authorizeRoles('admin', 'marketing_manager', 'order_manager'));
router.use(requireStrictAdminStorefrontScope);

router.get('/', listCorporateGiftEnquiries);
router.get('/:id', getCorporateGiftEnquiry);
router.patch('/:id/status', updateCorporateGiftEnquiryStatus);

module.exports = router;
