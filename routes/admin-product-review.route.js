const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/auth.middleware');
const { authorizeRoles } = require('../middlewares/authorize-roles.middleware');
const {
  listAdminReviews,
  patchReviewStatus,
  createAdminGeneratedReview,
  updateAdminGeneratedReview,
  deleteAdminGeneratedReview
} = require('../controllers/product-review.controller');

router.use(verifyToken);
router.use(authorizeRoles('admin'));

router.get('/', listAdminReviews);
router.patch('/:id/status', patchReviewStatus);
router.post('/generated', createAdminGeneratedReview);
router.put('/generated/:id', updateAdminGeneratedReview);
router.delete('/generated/:id', deleteAdminGeneratedReview);

module.exports = router;
