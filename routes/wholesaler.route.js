const express = require('express');
const { body, param, query } = require('express-validator');
const { requireAdmin, requireSuperAdmin } = require('../middlewares/is-admin.middleware');
const { uploadWholesalerProofs } = require('../middlewares/upload.middleware');
const {
  submitWholesalerRequest,
  completeWholesalerDetails,
  getWholesalerOnboardingStatus,
  listWholesalerRequests,
  getWholesalerRequestDetails,
  approveWholesalerRequest,
  rejectWholesalerRequest,
  createWholesalerRegistrationPaymentOrder,
  verifyWholesalerRegistrationPayment,
  sendWholesalerActivationOtp,
  verifyWholesalerActivationOtp,
  getWholesalerRequestSummary,
  buildNotifyOwnerPayload,
  buildNotifyApplicantPayload,
  getOwnerReviewPage,
  postOwnerReviewDecision
} = require('../controllers/wholesaler.controller');

const router = express.Router();

router.get('/owner-review', getOwnerReviewPage);
router.post(
  '/owner-review/decision',
  [
    body('token').trim().notEmpty().withMessage('token is required'),
    body('decision').isIn(['approve', 'reject']).withMessage('decision must be approve or reject'),
    body('reason').optional().isLength({ max: 500 }).withMessage('reason too long')
  ],
  postOwnerReviewDecision
);

/**
 * Phase 1: basic interest (name, email, phone, WhatsApp).
 * Legacy clients that still POST full KYC + proofs in one shot are accepted
 * and treated as details-complete pending owner approval.
 */
router.post(
  '/request',
  uploadWholesalerProofs,
  [
    body('fullName').trim().notEmpty().withMessage('fullName is required'),
    body('whatsappNumber').trim().notEmpty().withMessage('whatsappNumber is required'),
    body('mobileNumber').trim().notEmpty().withMessage('mobileNumber is required'),
    body('email').trim().isEmail().withMessage('Valid email is required'),
    body('permanentAddress').optional({ checkFalsy: true }).trim().isString(),
    body('businessAddress').optional({ checkFalsy: true }).trim().isString(),
    body('deliveryAddress').optional({ checkFalsy: true }).trim().isString(),
    body('sellingPlaceFrom').optional({ checkFalsy: true }).trim().isString(),
    body('sellingZoneCity').optional({ checkFalsy: true }).trim().isString(),
    body('productCategory').optional({ checkFalsy: true }).trim().isString(),
    body('monthlyEstimatedPurchase').optional({ checkFalsy: true }).isNumeric(),
    body('idProofUpload')
      .optional({ checkFalsy: true })
      .trim()
      .isString()
      .withMessage('idProofUpload must be a string URL when provided'),
    body('businessAddressProofUpload')
      .optional({ checkFalsy: true })
      .trim()
      .isString()
      .withMessage('businessAddressProofUpload must be a string URL when provided')
  ],
  submitWholesalerRequest
);

/**
 * Phase 2: after owner approval — business details + proofs; sends activation OTP on success.
 */
router.post(
  '/complete-details',
  uploadWholesalerProofs,
  [
    body('mobileNumber').trim().notEmpty().withMessage('mobileNumber is required'),
    body('permanentAddress').trim().notEmpty().withMessage('permanentAddress is required'),
    body('businessAddress').trim().notEmpty().withMessage('businessAddress is required'),
    body('deliveryAddress').trim().notEmpty().withMessage('deliveryAddress is required'),
    body('sellingPlaceFrom').trim().notEmpty().withMessage('sellingPlaceFrom is required'),
    body('sellingZoneCity').trim().notEmpty().withMessage('sellingZoneCity is required'),
    body('productCategory').trim().notEmpty().withMessage('productCategory is required'),
    body('monthlyEstimatedPurchase').isNumeric().withMessage('monthlyEstimatedPurchase must be numeric'),
    body('idProofUpload')
      .optional({ checkFalsy: true })
      .trim()
      .isString()
      .withMessage('idProofUpload must be a string URL when provided'),
    body('businessAddressProofUpload')
      .optional({ checkFalsy: true })
      .trim()
      .isString()
      .withMessage('businessAddressProofUpload must be a string URL when provided')
  ],
  completeWholesalerDetails
);

router.get(
  '/onboarding-status',
  [query('mobileNumber').trim().notEmpty().withMessage('mobileNumber is required')],
  getWholesalerOnboardingStatus
);

router.post(
  '/activate/payment-order',
  [body('mobileNumber').trim().notEmpty().withMessage('mobileNumber is required')],
  createWholesalerRegistrationPaymentOrder
);

router.post(
  '/activate/payment-verify',
  [
    body('mobileNumber').trim().notEmpty().withMessage('mobileNumber is required'),
    body('razorpay_order_id').trim().notEmpty().withMessage('razorpay_order_id is required'),
    body('razorpay_payment_id').trim().notEmpty().withMessage('razorpay_payment_id is required'),
    body('razorpay_signature').trim().notEmpty().withMessage('razorpay_signature is required')
  ],
  verifyWholesalerRegistrationPayment
);

router.post(
  '/activate/send-otp',
  [body('mobileNumber').trim().notEmpty().withMessage('mobileNumber is required')],
  sendWholesalerActivationOtp
);

router.post(
  '/activate/verify',
  [
    body('mobileNumber').trim().notEmpty().withMessage('mobileNumber is required'),
    body('otp').trim().notEmpty().withMessage('otp is required'),
    body('password').isLength({ min: 6 }).withMessage('password must be at least 6 characters')
  ],
  verifyWholesalerActivationOtp
);

router.get('/admin/requests', requireAdmin, listWholesalerRequests);
router.get('/admin/requests/summary', requireAdmin, getWholesalerRequestSummary);
router.get(
  '/admin/requests/:id',
  [param('id').isMongoId().withMessage('Valid request id is required')],
  requireAdmin,
  getWholesalerRequestDetails
);
router.get(
  '/admin/requests/:id/notify-owner',
  [param('id').isMongoId().withMessage('Valid request id is required')],
  requireAdmin,
  buildNotifyOwnerPayload
);
router.get(
  '/admin/requests/:id/notify-applicant',
  [param('id').isMongoId().withMessage('Valid request id is required')],
  requireAdmin,
  buildNotifyApplicantPayload
);
router.post(
  '/admin/requests/:id/approve',
  [param('id').isMongoId().withMessage('Valid request id is required')],
  requireSuperAdmin,
  approveWholesalerRequest
);
router.post(
  '/admin/requests/:id/reject',
  [param('id').isMongoId().withMessage('Valid request id is required')],
  requireSuperAdmin,
  rejectWholesalerRequest
);

module.exports = router;
