


const express = require('express');
const { body } = require('express-validator');
const { 
    register,           // ✅ Direct register + login (no OTP)
    login,              // ✅ Modified: accept email OR phone + password
    logout, 
    me, 
    updateProfile, 
    requestContactChangeOTP,
    verifyContactChangeOTP,
    changePassword,
    findUserForPasswordReset, // ✅ Option D (ecomm): phone → resetToken
    resetPasswordDirect,      // ✅ Option D (ecomm): resetToken → new password
    // Legacy OTP forgot-password kept live for wholesaleFrontend compatibility
    sendPasswordResetOTP,
    verifyPasswordResetOTP,
    resetPasswordWithOTP,
    refreshAccessToken, 
    googleAuth ,
    getActiveDevices,
    logoutDevice,
    logoutAllDevices
} = require('../controllers/auth.controller');
const { verifyToken } = require('../middlewares/auth.middleware');

const router = express.Router();

// =============================================
// 1️⃣ REGISTER FLOW (One-time: name, email, phone, password)
// =============================================

// Step 1: Register with all details and immediately log the user in.
// Email is optional; phone is mandatory.
router.post(
    '/register',
    [
        body('name')
            .trim()
            .notEmpty()
            .withMessage('Name is required')
            .isLength({ min: 2 })
            .withMessage('Name must be at least 2 characters'),
        body('email')
            .trim()
            .optional({ checkFalsy: true })
            .isEmail()
            .withMessage('Invalid email format')
            .normalizeEmail(),
        body('phone')
            .trim()
            .notEmpty()
            .withMessage('Phone number is required')
            .matches(/^[0-9]{10}$/)
            .withMessage('Phone number must be 10 digits'),
        body('password')
            .notEmpty()
            .withMessage('Password is required')
            .isLength({ min: 6 })
            .withMessage('Password must be at least 6 characters')
    ],
    register  // ✅ Creates/repairs user, marks verified, returns tokens
);

// Legacy OTP verify route intentionally kept here as commented reference for safe rollback.
// router.post('/otp-verify-login', [...validators], verifyOTPAndLogin);

// =============================================
// 2️⃣ LOGIN FLOW (Email OR Phone + Password)
// =============================================

router.post(
    '/login',
    [
        body('identifier')
            .trim()
            .notEmpty()
            .withMessage('Email or Phone number is required'),
        body('password')
            .notEmpty()
            .withMessage('Password is required'),
        body('portal')
            .optional()
            .isIn(['ecomm', 'wholesale', 'admin-ecomm', 'admin-wholesale'])
            .withMessage('portal must be one of: ecomm, wholesale, admin-ecomm, admin-wholesale')
    ],
    login  // ✅ Accepts "email@example.com" OR "9876543210"
);

// =============================================
// 3️⃣ FORGOT PASSWORD FLOW
// =============================================

// --- Option D (ecomm): phone + rate-limit + silent email security net ---
router.post(
    '/forgot-password/find-user',
    [
        body('phone')
            .trim()
            .notEmpty()
            .withMessage('Phone number is required')
            .matches(/^[0-9]{10}$/)
            .withMessage('Phone number must be 10 digits')
    ],
    findUserForPasswordReset
);

router.post(
    '/forgot-password/reset-direct',
    [
        body('resetToken')
            .trim()
            .notEmpty()
            .withMessage('Reset token is required'),
        body('newPassword')
            .notEmpty()
            .withMessage('New password is required')
            .isLength({ min: 6 })
            .withMessage('Password must be at least 6 characters'),
        body('confirmPassword')
            .notEmpty()
            .withMessage('Confirm password is required')
    ],
    resetPasswordDirect
);

// --- Legacy OTP forgot-password (kept LIVE for wholesaleFrontend) ---
// Ecomm no longer uses these. Do not remove until wholesale is migrated.
router.post(
    '/forgot-password/request-otp',
    [
        body('identifier')
            .trim()
            .notEmpty()
            .withMessage('Email or Phone number is required')
    ],
    sendPasswordResetOTP
);

router.post(
    '/forgot-password/verify-otp',
    [
        body('identifier')
            .trim()
            .notEmpty()
            .withMessage('Email or Phone number is required'),
        body('otp')
            .trim()
            .notEmpty()
            .withMessage('OTP is required')
    ],
    verifyPasswordResetOTP
);

router.post(
    '/forgot-password/reset',
    [
        body('identifier')
            .trim()
            .notEmpty()
            .withMessage('Email or Phone number is required'),
        body('otp')
            .trim()
            .notEmpty()
            .withMessage('OTP is required'),
        body('newPassword')
            .notEmpty()
            .withMessage('New password is required')
            .isLength({ min: 6 })
            .withMessage('Password must be at least 6 characters')
    ],
    resetPasswordWithOTP
);  //done

// =============================================
// 4️⃣ CHANGE PASSWORD (Logged in user)
// =============================================

router.put(
    '/change-password',
    verifyToken,
    [
        body('oldPassword')
            .notEmpty()
            .withMessage('Old password is required'),
        body('newPassword')
            .notEmpty()
            .withMessage('New password is required')
            .isLength({ min: 6 })
            .withMessage('Password must be at least 6 characters')
    ],
    changePassword
);   //done

// =============================================
// 5️⃣ GOOGLE AUTH
// =============================================

router.post('/google', [
    body('idToken').notEmpty().withMessage('idToken is required')
], googleAuth);

// =============================================
// 6️⃣ REFRESH TOKEN & LOGOUT
// =============================================

router.post('/refresh', refreshAccessToken);  //done
router.post('/logout', verifyToken, logout);   //done

// =============================================
// 7️⃣ USER PROFILE (Protected)
// =============================================

router.get('/me', verifyToken, me);     //done
router.put('/profile', verifyToken, updateProfile);   //done
router.post(
    '/profile/contact-change/request-otp',
    verifyToken,
    [
        body('field')
            .trim()
            .notEmpty()
            .withMessage('field is required')
            .isIn(['email', 'phone'])
            .withMessage('field must be one of: email, phone'),
        body('newValue')
            .trim()
            .notEmpty()
            .withMessage('newValue is required')
    ],
    requestContactChangeOTP
);
router.post(
    '/profile/contact-change/verify-otp',
    verifyToken,
    [
        body('otp')
            .trim()
            .notEmpty()
            .withMessage('otp is required')
    ],
    verifyContactChangeOTP
);


// =============================================
// DEVICE MANAGEMENT ROUTES
// =============================================

// Get all active devices
router.get('/devices', verifyToken, getActiveDevices);

// Logout from specific device
router.post('/devices/logout', verifyToken, logoutDevice);

// Logout from all devices
router.post('/logout-all', verifyToken, logoutAllDevices);

module.exports = router;