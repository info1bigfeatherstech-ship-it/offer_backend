const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/auth.middleware');
const {
  getMyReviewForProduct,
  createCustomerReview,
  updateCustomerReview
} = require('../controllers/product-review.controller');

router.get('/mine/:productId', verifyToken, getMyReviewForProduct);
router.post('/', verifyToken, createCustomerReview);
router.put('/:id', verifyToken, updateCustomerReview);

module.exports = router;
