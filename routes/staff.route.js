/**
 * Staff Management Routes
 * All routes are protected with Admin authentication
 *
 * IMPORTANT: Static paths (`/profile/me`, `/`) must be registered BEFORE `/:id`
 * so Express does not treat "profile" as a staff id.
 *
 * @version 2.1.0
 * @author OfferWaleBaba Team
 */

const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const { verifyToken } = require('../middlewares/auth.middleware');
const { authorizeRoles } = require('../middlewares/authorize-roles.middleware');
const { requireStrictAdminStorefrontScope } = require('../middlewares/admin-storefront-scope.middleware');
const staffController = require('../controllers/staff.controller');

// =============================================
// GLOBAL MIDDLEWARE - All routes require admin access
// =============================================
router.use(verifyToken);
router.use(authorizeRoles('admin'));
router.use(requireStrictAdminStorefrontScope);

// =============================================
// ADMIN'S OWN PROFILE (before /:id)
// =============================================

/**
 * @route   GET /api/admin/staff/profile/me
 * @desc    Get admin's own profile (view only)
 * @access  Admin only
 */
router.get('/profile/me', staffController.getAdminProfile);

/**
 * @route   PUT /api/admin/staff/profile/me
 * @desc    Update admin's own profile (name, phone only)
 * @access  Admin only
 * @body    name, phone (both optional)
 */
router.put(
  '/profile/me',
  [
    body('name').optional().trim(),
    body('phone')
      .optional()
      .trim()
      .matches(/^[0-9]{10}$/)
      .withMessage('Phone number must be 10 digits')
  ],
  staffController.updateOwnProfile
);

/**
 * @route   POST /api/admin/staff/profile/me/initiate-password-reset
 * @desc    Send OTP to logged-in admin email (self password reset)
 * @access  Admin only — storefront scoped via x-storefront
 */
router.post(
  '/profile/me/initiate-password-reset',
  staffController.initiateSelfPasswordReset
);

/**
 * @route   POST /api/admin/staff/profile/me/verify-password-reset
 * @desc    Verify OTP and set new admin password
 * @access  Admin only — storefront scoped via x-storefront
 * @body    otp, newPassword, confirmPassword?
 */
router.post(
  '/profile/me/verify-password-reset',
  [
    body('otp')
      .notEmpty()
      .withMessage('OTP is required')
      .matches(/^\d{6}$/)
      .withMessage('OTP must be a 6-digit number'),
    body('newPassword')
      .notEmpty()
      .withMessage('New password is required')
      .isLength({ min: 6 })
      .withMessage('Password must be at least 6 characters'),
    body('confirmPassword')
      .optional({ values: 'falsy' })
      .custom((value, { req }) => {
        if (value != null && String(value) !== String(req.body.newPassword || '')) {
          throw new Error('New password and confirmation do not match');
        }
        return true;
      })
  ],
  staffController.verifySelfPasswordReset
);

// =============================================
// STAFF CRUD OPERATIONS
// =============================================

/**
 * @route   GET /api/admin/staff
 * @desc    Get all staff members (paginated)
 * @access  Admin only
 * @query   page, limit, search, role
 */
router.get('/', staffController.getAllStaff);

/**
 * @route   POST /api/admin/staff
 * @desc    Create a new staff member
 * @access  Admin only
 * @body    name, email, phone, password, role
 */
router.post(
  '/',
  [
    body('name')
      .optional({ values: 'falsy' })
      .trim()
      .isLength({ min: 2 })
      .withMessage('Name must be at least 2 characters'),
    body('email')
      .trim()
      .notEmpty()
      .withMessage('Email is required')
      .isEmail()
      .withMessage('Valid email is required')
      .normalizeEmail(),
    body('phone')
      .optional({ values: 'falsy' })
      .trim()
      .matches(/^[0-9]{10}$/)
      .withMessage('Phone number must be 10 digits'),
    body('password')
      .notEmpty()
      .withMessage('Password is required')
      .isLength({ min: 6 })
      .withMessage('Password must be at least 6 characters'),
    body('role')
      .isIn(['product_manager', 'order_manager', 'marketing_manager'])
      .withMessage('Invalid role')
  ],
  staffController.createStaff
);

/**
 * @route   POST /api/admin/staff/:id/initiate-reset
 * @desc    Initiate password reset - sends OTP to admin email
 * @access  Admin only
 */
router.post('/:id/initiate-reset', staffController.initiatePasswordReset);

/**
 * @route   POST /api/admin/staff/:id/verify-reset
 * @desc    Verify OTP and reset staff password
 * @access  Admin only
 * @body    otp, newPassword
 */
router.post(
  '/:id/verify-reset',
  [
    body('otp')
      .notEmpty()
      .withMessage('OTP is required')
      .matches(/^\d{6}$/)
      .withMessage('OTP must be a 6-digit number'),
    body('newPassword')
      .notEmpty()
      .withMessage('New password is required')
      .isLength({ min: 6 })
      .withMessage('Password must be at least 6 characters')
  ],
  staffController.verifyOTPAndResetPassword
);

/**
 * @route   GET /api/admin/staff/:id
 * @desc    Get single staff member by ID
 * @access  Admin only
 */
router.get('/:id', staffController.getStaffById);

/**
 * @route   PUT /api/admin/staff/:id
 * @desc    Update staff member details
 * @access  Admin only
 * @body    name, email, phone, role, status (all optional)
 */
router.put('/:id', staffController.updateStaff);

/**
 * @route   DELETE /api/admin/staff/:id
 * @desc    Delete staff member
 * @access  Admin only
 */
router.delete('/:id', staffController.deleteStaff);

module.exports = router;
