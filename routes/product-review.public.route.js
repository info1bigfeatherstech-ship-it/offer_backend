const express = require('express');
const router = express.Router();
const {
  getPublicSummary,
  listPublicReviews
} = require('../controllers/product-review.controller');

router.get('/:productId/summary', getPublicSummary);
router.get('/:productId', listPublicReviews);

module.exports = router;
