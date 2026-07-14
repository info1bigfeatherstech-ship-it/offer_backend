/**
 * Public out-of-stock inquiry routes (guest OK; optionalAuth may attach userId).
 */
const express = require('express');
const { body } = require('express-validator');
const { validationResult } = require('express-validator');
const {
  submitOutOfStockInquiry,
} = require('../controllers/out-of-stock-inquiry.controller');

const router = express.Router();

function rejectValidationErrors(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      code: 'VALIDATION_FAILED',
      message: errors.array()[0]?.msg || 'Validation failed',
      errors: errors.array(),
    });
  }
  return next();
}

router.post(
  '/',
  [
    body('productId').trim().notEmpty().withMessage('productId is required'),
    body('variantId').trim().notEmpty().withMessage('variantId is required'),
    body('email').trim().notEmpty().withMessage('email is required').isLength({ max: 254 }),
    body('phone')
      .trim()
      .notEmpty()
      .withMessage('phone is required')
      .isLength({ min: 10, max: 10 })
      .withMessage('Phone must be 10 digits'),
  ],
  rejectValidationErrors,
  submitOutOfStockInquiry
);

module.exports = router;
