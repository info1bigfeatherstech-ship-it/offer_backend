const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/auth.middleware');
const { authorizeRoles } = require('../middlewares/authorize-roles.middleware');
const { requireAdminStorefrontScope } = require('../middlewares/admin-storefront-scope.middleware');
const {
  listAdminReviews,
  patchReviewStatus,
  createAdminGeneratedReview,
  updateAdminGeneratedReview,
  deleteAdminGeneratedReview
} = require('../controllers/product-review.controller');

router.use(verifyToken);
router.use(authorizeRoles('admin'));
/** Non-strict: missing header → ecomm (live ecomm admin safe). Wholesale FE sends x-storefront. */
router.use(requireAdminStorefrontScope);

router.get('/', listAdminReviews);
router.patch('/:id/status', patchReviewStatus);
router.post('/generated', createAdminGeneratedReview);
router.put('/generated/:id', updateAdminGeneratedReview);
router.delete('/generated/:id', deleteAdminGeneratedReview);

module.exports = router;
