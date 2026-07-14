const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/auth.middleware');
const { uploadReviewImages } = require('../middlewares/upload.middleware');
const {
  getMyReviewForProduct,
  getReviewEligibilityForProduct,
  getReviewableItemsForOrder,
  createCustomerReview,
  updateCustomerReview,
  deleteCustomerReview
} = require('../controllers/product-review.controller');

router.get('/eligibility/:productId', verifyToken, getReviewEligibilityForProduct);
router.get('/order/:orderId/items', verifyToken, getReviewableItemsForOrder);
router.get('/mine/:productId', verifyToken, getMyReviewForProduct);
router.post('/', verifyToken, uploadReviewImages, createCustomerReview);
router.put('/:id', verifyToken, uploadReviewImages, updateCustomerReview);
router.delete('/:id', verifyToken, deleteCustomerReview);

module.exports = router;
