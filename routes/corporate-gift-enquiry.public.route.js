/**
 * Public corporate customise-gift + bulk-order enquiry submit.
 * Guest OK; optionalAuth may attach userId.
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { uploadGiftEnquiryFiles } = require('../middlewares/upload.middleware');
const { submitCorporateGiftEnquiry } = require('../controllers/corporate-gift-enquiry.controller');
const { MAX_MESSAGE_LEN } = require('../utils/corporateGiftEnquiryValidation');

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
  uploadGiftEnquiryFiles,
  [
    body('enquiryType')
      .trim()
      .notEmpty()
      .withMessage('enquiryType is required')
      .isIn(['custom', 'bulk'])
      .withMessage('enquiryType must be custom or bulk'),
    body('name').trim().notEmpty().withMessage('Name is required').isLength({ min: 2, max: 120 }),
    body('email').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 254 }),
    body('phone').trim().notEmpty().withMessage('Phone is required'),
    body('city').optional({ nullable: true, checkFalsy: true }).trim().isLength({ min: 2, max: 120 }),
    body('organizationName').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 160 }),
    body('occasion').optional({ nullable: true, checkFalsy: true }).trim().isLength({ min: 2, max: 120 }),
    body('giftCategory').optional({ nullable: true, checkFalsy: true }).trim().isLength({ min: 2, max: 120 }),
    body('quantity').optional({ nullable: true, checkFalsy: true }).trim(),
    body('targetDeliveryDate').optional({ nullable: true, checkFalsy: true }).trim(),
    body('message').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: MAX_MESSAGE_LEN }),
    body('businessType').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 120 }),
    body('volumeOrder').optional({ nullable: true, checkFalsy: true }).trim(),
  ],
  rejectValidationErrors,
  submitCorporateGiftEnquiry
);

module.exports = router;
