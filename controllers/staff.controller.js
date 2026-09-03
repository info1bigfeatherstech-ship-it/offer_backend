/**
 * Staff Management Controller
 * 
 * @description Complete staff management system with role-based access control
 * @version 11.0.0
 * @author OfferWaleBaba Team
 * @license Proprietary
 * 
 * Features:
 * - CRUD operations for staff (admin only)
 * - Secure password reset with OTP (admin receives OTP)
 * - Redis-based OTP storage with automatic expiration
 * - Email notifications for password reset actions
 * - Rate limiting ready
 * - No model changes required
 */

const User = require('../models/User');
const { validationResult } = require('express-validator');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const redisManager = require('../config/redis.config');

// ==============================
// CONSTANTS & CONFIGURATION
// ==============================

/** Allowed roles for staff members (admin only) */
const ALLOWED_STAFF_ROLES = ['product_manager', 'order_manager', 'marketing_manager', 'inventory_manager'];

/** OTP expiration time in seconds (10 minutes) */
const OTP_EXPIRY_SECONDS = 600;

/** OTP length (6 digits) */
const OTP_LENGTH = 6;

/** Admin self-reset: max OTP sends per hour (per admin + storefront) */
const SELF_RESET_OTP_SEND_LIMIT = 5;
const SELF_RESET_OTP_SEND_WINDOW_SECONDS = 3600;

/** Admin self-reset: max failed OTP verifies before OTP is invalidated */
const SELF_RESET_OTP_FAIL_LIMIT = 5;

/** Email configuration */
const EMAIL_FROM = process.env.EMAIL_USER;

// ==============================
// EMAIL TRANSPORTER
// ==============================

/**
 * Same pattern as email-otp.provider / auth.controller:
 * await nodemailer sendMail until SMTP accepts or truly fails.
 * Do NOT Promise.race a short timer — Gmail often delivers after 8–15s while
 * still succeeding; a race would return EMAIL_SEND_TIMEOUT and delete Redis OTP
 * even though the user already received the code.
 */
let cachedTransporter = null;

function getMailTransporter() {
  if (cachedTransporter) return cachedTransporter;

  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASSWORD;
  if (!user || !pass) {
    const err = new Error(
      'Email transport not configured: set EMAIL_USER and EMAIL_PASSWORD.'
    );
    err.code = 'EMAIL_NOT_CONFIGURED';
    throw err;
  }

  cachedTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass }
  });
  return cachedTransporter;
}

/**
 * @param {import('nodemailer').SendMailOptions} mailOptions
 * @returns {Promise<import('nodemailer').SentMessageInfo>}
 */
async function sendMail(mailOptions) {
  const transporter = getMailTransporter();
  return transporter.sendMail(mailOptions);
}

/**
 * Fire-and-forget email (never blocks the HTTP response).
 * Used only for post-success confirmation mail — not for OTP delivery.
 * @param {string} label
 * @param {() => Promise<unknown>} sendFn
 */
function enqueueBackgroundEmail(label, sendFn) {
  setImmediate(() => {
    Promise.resolve()
      .then(() => sendFn())
      .catch((err) => {
        console.error(`[StaffController] ${label}:`, err?.message || err);
      });
  });
}

// ==============================
// HELPER FUNCTIONS
// ==============================

/**
 * Generate a 6-digit OTP
 * @returns {string} 6-digit OTP
 */
const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

/**
 * Store OTP in Redis (overwrites existing OTP for same admin-staff pair)
 * @param {string} adminId - Admin user ID
 * @param {string} staffId - Staff user ID
 * @param {string} otp - Generated OTP
 * @returns {Promise<boolean>}
 */
const storeOTP = async (adminId, staffId, otp) => {
  if (!redisManager.isReady()) {
    throw new Error('Redis service unavailable');
  }
  
  const redisKey = `admin_reset:${adminId}:${staffId}`;
  await redisManager.getClient().setEx(redisKey, OTP_EXPIRY_SECONDS, otp);
  return true;
};

/**
 * Verify OTP from Redis (deletes after verification)
 * @param {string} adminId - Admin user ID
 * @param {string} staffId - Staff user ID
 * @param {string} otp - OTP to verify
 * @returns {Promise<boolean>}
 */
const verifyOTP = async (adminId, staffId, otp) => {
  if (!redisManager.isReady()) {
    throw new Error('Redis service unavailable');
  }
  
  const redisKey = `admin_reset:${adminId}:${staffId}`;
  const storedOTP = await redisManager.getClient().get(redisKey);
  
  if (!storedOTP) {
    return false;
  }
  
  if (storedOTP !== otp) {
    return false;
  }
  
  // Delete OTP after successful verification (one-time use)
  await redisManager.getClient().del(redisKey);
  return true;
};

/**
 * Send OTP to admin's email for password reset verification
 * @param {string} adminEmail - Admin email address
 * @param {string} adminName - Admin name
 * @param {string} staffName - Staff name
 * @param {string} otp - Generated OTP
 * @returns {Promise<void>}
 */
const sendOTPToAdmin = async (adminEmail, adminName, staffName, otp) => {
  const mailOptions = {
    from: `"OfferWaleBaba Security" <${EMAIL_FROM}>`,
    to: adminEmail,
    subject: ' Staff Password Reset Verification',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 0; background-color: #f4f4f4;">
        <div style="max-width: 550px; margin: 20px auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
          <div style="background-color: #1a1a2e; padding: 25px; text-align: center;">
            <h2 style="color: #ffffff; margin: 0;">🔐 Password Reset Request</h2>
          </div>
          
          <div style="padding: 30px 25px;">
            <p style="color: #333; font-size: 16px; margin: 0 0 10px 0;">Dear <strong>${adminName}</strong>,</p>
            <p style="color: #555; font-size: 14px; line-height: 1.5; margin: 0 0 20px 0;">
              You have requested to reset the password for staff member:
            </p>
            
            <div style="background-color: #f8f9fa; padding: 15px; border-radius: 8px; margin: 0 0 20px 0; border-left: 4px solid #007bff;">
              <p style="margin: 0; color: #1a1a2e; font-weight: 600;">👤 Name: ${staffName}</p>
            </div>
            
            <p style="color: #555; font-size: 14px; margin: 0 0 15px 0;">
              Use the following One-Time Password (OTP) to verify this action:
            </p>
            
            <div style="background-color: #1a1a2e; padding: 20px; text-align: center; border-radius: 10px; margin: 0 0 20px 0;">
              <span style="font-size: 36px; font-weight: bold; letter-spacing: 8px; color: #ffffff;">${otp}</span>
            </div>
            
            <div style="background-color: #fff3cd; padding: 12px; border-radius: 6px; margin: 0 0 20px 0; border-left: 4px solid #ffc107;">
              <p style="margin: 0; color: #856404; font-size: 13px;">
                ⏰ This OTP expires in ${OTP_EXPIRY_SECONDS / 60} minutes
              </p>
              <p style="margin: 5px 0 0 0; color: #856404; font-size: 13px;">
                🔒 One-time use only
              </p>
            </div>
            
            <hr style="margin: 20px 0; border: none; border-top: 1px solid #eee;" />
            
            <p style="color: #999; font-size: 12px; margin: 0;">
              If you did not initiate this request, please ignore this email.
            </p>
          </div>
        </div>
      </body>
      </html>
    `
  };

  await sendMail(mailOptions);
};

/**
 * Send confirmation email to admin after successful password reset
 * @param {string} adminEmail - Admin email address
 * @param {string} adminName - Admin name
 * @param {string} staffName - Staff name
 * @returns {Promise<void>}
 */
const sendResetConfirmation = async (adminEmail, adminName, staffName) => {
  const mailOptions = {
    from: `"OfferWaleBaba Security" <${EMAIL_FROM}>`,
    to: adminEmail,
    subject: 'Staff Password Reset Successful',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 0; background-color: #f4f4f4;">
        <div style="max-width: 550px; margin: 20px auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
          <div style="background-color: #28a745; padding: 25px; text-align: center;">
            <h2 style="color: #ffffff; margin: 0;">✅ Password Reset Successful</h2>
          </div>
          
          <div style="padding: 30px 25px;">
            <p style="color: #333; font-size: 16px; margin: 0 0 10px 0;">Dear <strong>${adminName}</strong>,</p>
            <p style="color: #555; font-size: 14px; line-height: 1.5; margin: 0 0 20px 0;">
              The password for staff member <strong>${staffName}</strong> has been successfully reset.
            </p>
            
            <hr style="margin: 20px 0; border: none; border-top: 1px solid #eee;" />
            
            <p style="color: #999; font-size: 12px; margin: 0;">
              If you did not perform this action, please contact support immediately.
            </p>
          </div>
        </div>
      </body>
      </html>
    `
  };
  await sendMail(mailOptions);
};

/**
 * Build staff query with search and role filters
 * @param {string} search - Search term
 * @param {string} role - Role filter
 * @returns {object} MongoDB query object
 */

const buildStaffQuery = (search, role, storefront) => {
  const storefrontScope =
    storefront === 'wholesale'
      ? { allowedStorefronts: 'wholesale' }
      : {
          $or: [
            { allowedStorefronts: 'ecomm' },
            { allowedStorefronts: { $exists: false } },
            { allowedStorefronts: [] }
          ]
        };

  const query = {
    role: { $ne: 'user', $in: ALLOWED_STAFF_ROLES },
    ...storefrontScope
  };

  if (search) {
    query.$or = [
      { name: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } },
      { phone: { $regex: search, $options: 'i' } }
    ];
  }

  if (role && ALLOWED_STAFF_ROLES.includes(role)) {
    query.role = role;
  }

  return query;
};

const storefrontFromScope = (req) => req.adminScope?.storefront || 'ecomm';

/**
 * Timing-safe digit OTP compare. Normalizes to digits-only strings first.
 * @param {string} a
 * @param {string} b
 */
const otpsEqual = (a, b) => {
  const norm = (v) => String(v ?? '').replace(/\D/g, '');
  const aa = Buffer.from(norm(a), 'utf8');
  const bb = Buffer.from(norm(b), 'utf8');
  if (aa.length !== bb.length || aa.length === 0) return false;
  return crypto.timingSafeEqual(aa, bb);
};

/**
 * Normalize Redis GET value to string (handles Buffer / odd client returns).
 * @param {unknown} value
 */
const redisValueToString = (value) => {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return String(value);
};

/**
 * Mask email for API responses (never leak full address unnecessarily).
 * @param {string|null|undefined} email
 */
const maskEmail = (email) => {
  const s = String(email || '').trim();
  const at = s.indexOf('@');
  if (at < 1) return 'your registered email';
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}***@${domain}`;
};

const selfResetOtpKey = (storefront, adminId) =>
  `admin_self_reset:${storefront}:${adminId}`;
const selfResetRateKey = (storefront, adminId) =>
  `admin_self_reset_rate:${storefront}:${adminId}`;
const selfResetFailKey = (storefront, adminId) =>
  `admin_self_reset_fail:${storefront}:${adminId}`;

/**
 * Send OTP to admin for their own password reset (storefront-scoped flow).
 */
const sendSelfPasswordResetOTP = async (adminEmail, adminName, otp, storefront) => {
  const scopeLabel = storefront === 'wholesale' ? 'Wholesale' : 'E-commerce';
  const mailOptions = {
    from: `"OfferWaleBaba Security" <${EMAIL_FROM}>`,
    to: adminEmail,
    subject: `Admin Password Reset Verification (${scopeLabel})`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 0; background-color: #f4f4f4;">
        <div style="max-width: 550px; margin: 20px auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
          <div style="background-color: #1a1a2e; padding: 25px; text-align: center;">
            <h2 style="color: #ffffff; margin: 0;">Admin Password Reset</h2>
          </div>
          <div style="padding: 30px 25px;">
            <p style="color: #333; font-size: 16px; margin: 0 0 10px 0;">Dear <strong>${adminName || 'Admin'}</strong>,</p>
            <p style="color: #555; font-size: 14px; line-height: 1.5; margin: 0 0 20px 0;">
              You requested to reset your admin password for the <strong>${scopeLabel}</strong> dashboard.
            </p>
            <p style="color: #555; font-size: 14px; margin: 0 0 15px 0;">
              Use this One-Time Password (OTP) to continue:
            </p>
            <div style="background-color: #1a1a2e; padding: 20px; text-align: center; border-radius: 10px; margin: 0 0 20px 0;">
              <span style="font-size: 36px; font-weight: bold; letter-spacing: 8px; color: #ffffff;">${otp}</span>
            </div>
            <div style="background-color: #fff3cd; padding: 12px; border-radius: 6px; margin: 0 0 20px 0; border-left: 4px solid #ffc107;">
              <p style="margin: 0; color: #856404; font-size: 13px;">
                This OTP expires in ${OTP_EXPIRY_SECONDS / 60} minutes and can be used once.
              </p>
            </div>
            <hr style="margin: 20px 0; border: none; border-top: 1px solid #eee;" />
            <p style="color: #999; font-size: 12px; margin: 0;">
              If you did not request this, ignore this email. Your password will remain unchanged.
            </p>
          </div>
        </div>
      </body>
      </html>
    `
  };
  await sendMail(mailOptions);
};

/**
 * Confirmation email after admin self password reset.
 */
const sendSelfPasswordResetConfirmation = async (adminEmail, adminName, storefront) => {
  const scopeLabel = storefront === 'wholesale' ? 'Wholesale' : 'E-commerce';
  const mailOptions = {
    from: `"OfferWaleBaba Security" <${EMAIL_FROM}>`,
    to: adminEmail,
    subject: `Admin Password Updated (${scopeLabel})`,
    html: `
      <!DOCTYPE html>
      <html>
      <head><meta charset="UTF-8"></head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 0; background-color: #f4f4f4;">
        <div style="max-width: 550px; margin: 20px auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
          <div style="background-color: #28a745; padding: 25px; text-align: center;">
            <h2 style="color: #ffffff; margin: 0;">Password Updated</h2>
          </div>
          <div style="padding: 30px 25px;">
            <p style="color: #333; font-size: 16px; margin: 0 0 10px 0;">Dear <strong>${adminName || 'Admin'}</strong>,</p>
            <p style="color: #555; font-size: 14px; line-height: 1.5; margin: 0 0 20px 0;">
              Your admin password for the <strong>${scopeLabel}</strong> dashboard was updated successfully.
            </p>
            <p style="color: #999; font-size: 12px; margin: 0;">
              If you did not perform this action, contact support immediately.
            </p>
          </div>
        </div>
      </body>
      </html>
    `
  };
  await sendMail(mailOptions);
};

// ==============================
// CONTROLLER FUNCTIONS
// ==============================

/**
 * @route   GET /api/admin/staff
 * @desc    Get all staff members (paginated)
 * @access  Admin only
 * @query   page, limit, search, role
 */

const getAllStaff = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;
    const { search = '', role = '' } = req.query;

    const storefront = storefrontFromScope(req);
    const query = buildStaffQuery(search, role, storefront);
    
    const [staff, total] = await Promise.all([
      User.find(query)
        .select('name email phone role userType allowedStorefronts status createdAt updatedAt')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(query)
    ]);

    return res.status(200).json({
      success: true,
      message: 'Staff fetched successfully',
      scope: storefront,
      data: {
        staff,
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
          hasNextPage: page * limit < total,
          hasPrevPage: page > 1
        }
      }
    });
  } catch (error) {
    console.error('[StaffController] getAllStaff Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch staff',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * @route   POST /api/admin/staff
 * @desc    Create a new staff member
 * @access  Admin only
 * @body    name, email, phone, password, role
 */

const createStaff = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { name, email, phone, password, role } = req.body;
    const trimmedName = String(name || '').trim();
    const trimmedPhone = String(phone || '').trim();
    const storefront = storefrontFromScope(req);

    if (!ALLOWED_STAFF_ROLES.includes(role)) {
      return res.status(400).json({
        success: false,
        message: `Invalid role. Allowed roles: ${ALLOWED_STAFF_ROLES.join(', ')}`
      });
    }

    const existingEmail = await User.findOne({ email });
    if (existingEmail) {
      return res.status(409).json({
        success: false,
        message: 'User with this email already exists'
      });
    }

    if (trimmedPhone) {
      const existingPhone = await User.findOne({ phone: trimmedPhone });
      if (existingPhone) {
        return res.status(409).json({
          success: false,
          message: 'User with this phone number already exists'
        });
      }
    }

    const staff = new User({
      ...(trimmedName ? { name: trimmedName } : {}),
      email,
      ...(trimmedPhone ? { phone: trimmedPhone } : {}),
      password,
      role,
      userType: 'user',
      accountScope: 'staff',
      isEmailVerified: true,
      isPhoneVerified: true,
      isProfileComplete: true,
      status: 'active',
      registrationMethod: 'email',
      allowedStorefronts: [storefront]
    });

    await staff.save();

    const staffData = {
      _id: staff._id,
      name: staff.name,
      email: staff.email,
      phone: staff.phone,
      role: staff.role,
      userType: staff.userType,
      allowedStorefronts: staff.allowedStorefronts,
      status: staff.status,
      createdAt: staff.createdAt,
      updatedAt: staff.updatedAt
    };

    return res.status(201).json({
      success: true,
      message: 'Staff created successfully',
      data: staffData
    });
  } catch (error) {
    console.error('[StaffController] createStaff Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to create staff',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * @route   GET /api/admin/staff/:id
 * @desc    Get single staff member by ID
 * @access  Admin only
 */
const getStaffById = async (req, res) => {
  try {
    const { id } = req.params;
    const storefront = storefrontFromScope(req);
    const scopeFilter =
      storefront === 'wholesale'
        ? { allowedStorefronts: 'wholesale' }
        : {
            $or: [
              { allowedStorefronts: 'ecomm' },
              { allowedStorefronts: { $exists: false } },
              { allowedStorefronts: [] }
            ]
          };

    const staff = await User.findOne({ _id: id, ...scopeFilter })
      .select('name email phone role userType allowedStorefronts status createdAt updatedAt')
      .lean();

    if (!staff) {
      return res.status(404).json({
        success: false,
        message: 'Staff not found'
      });
    }

    if (staff.role === 'user') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Cannot view regular users.'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Staff fetched successfully',
      data: staff
    });
  } catch (error) {
    console.error('[StaffController] getStaffById Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch staff',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * @route   PUT /api/admin/staff/:id
 * @desc    Update staff member details
 * @access  Admin only
 * @body    name, email, phone, role, status (all optional)
 */
const updateStaff = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, phone, role, status } = req.body;
    const storefront = storefrontFromScope(req);
    const scopeFilter =
      storefront === 'wholesale'
        ? { allowedStorefronts: 'wholesale' }
        : {
            $or: [
              { allowedStorefronts: 'ecomm' },
              { allowedStorefronts: { $exists: false } },
              { allowedStorefronts: [] }
            ]
          };

    if (id === req.userId) {
      return res.status(403).json({
        success: false,
        message: 'Cannot modify your own account. Use profile settings.'
      });
    }

    const staff = await User.findOne({ _id: id, ...scopeFilter });
    if (!staff) {
      return res.status(404).json({
        success: false,
        message: 'Staff not found'
      });
    }

    const updates = {};
    if (name) updates.name = name;
    if (email) updates.email = email;
    if (phone) updates.phone = phone;
    
    if (role) {
      if (!ALLOWED_STAFF_ROLES.includes(role)) {
        return res.status(400).json({
          success: false,
          message: `Invalid role. Allowed roles: ${ALLOWED_STAFF_ROLES.join(', ')}`
        });
      }
      updates.role = role;
    }
    
    if (status) {
      if (!['active', 'inactive'].includes(status)) {
        return res.status(400).json({
          success: false,
          message: 'Status must be active or inactive'
        });
      }
      updates.status = status;
    }

    const updatedStaff = await User.findOneAndUpdate(
      { _id: id, ...scopeFilter },
      { $set: updates },
      { returnDocument: 'after', runValidators: true }
    ).select('name email phone role userType allowedStorefronts status createdAt updatedAt')
      .lean();

    return res.status(200).json({
      success: true,
      message: 'Staff updated successfully',
      data: updatedStaff
    });
  } catch (error) {
    console.error('[StaffController] updateStaff Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update staff',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * @route   POST /api/admin/staff/:id/initiate-reset
 * @desc    Initiate password reset - sends OTP to admin email
 * @access  Admin only
 */
const initiatePasswordReset = async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.userId;
    const storefront = storefrontFromScope(req);
    const scopeFilter =
      storefront === 'wholesale'
        ? { allowedStorefronts: 'wholesale' }
        : {
            $or: [
              { allowedStorefronts: 'ecomm' },
              { allowedStorefronts: { $exists: false } },
              { allowedStorefronts: [] }
            ]
          };

    // Prevent self reset
    if (id === adminId) {
      return res.status(403).json({
        success: false,
        message: 'Cannot reset your own password. Use change password.'
      });
    }

    // Get staff details
    const staff = await User.findOne({ _id: id, ...scopeFilter }).select('name email');
    if (!staff) {
      return res.status(404).json({
        success: false,
        message: 'Staff not found'
      });
    }

    // Get admin details
    const admin = await User.findById(adminId).select('email name');
    if (!admin) {
      return res.status(404).json({
        success: false,
        message: 'Admin not found'
      });
    }

    // Check Redis availability
    if (!redisManager.isReady()) {
      return res.status(503).json({
        success: false,
        message: 'Service temporarily unavailable. Please try again later.',
        code: 'REDIS_UNAVAILABLE'
      });
    }

    // Generate and store OTP
    const otp = generateOTP();
    await storeOTP(adminId, id, otp);
    
    // Send OTP to admin email
    await sendOTPToAdmin(admin.email, admin.name, staff.name, otp);

    return res.status(200).json({
      success: true,
      message: `OTP sent to ${admin.email}. Valid for ${OTP_EXPIRY_SECONDS / 60} minutes.`,
      data: {
        staffId: staff._id,
        staffName: staff.name,
        expiresIn: `${OTP_EXPIRY_SECONDS / 60} minutes`
      }
    });
  } catch (error) {
    console.error('[StaffController] initiatePasswordReset Error:', error);
    
    if (error.message === 'Redis service unavailable') {
      return res.status(503).json({
        success: false,
        message: 'Service temporarily unavailable. Please try again later.'
      });
    }
    
    return res.status(500).json({
      success: false,
      message: 'Failed to initiate password reset',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * @route   POST /api/admin/staff/:id/verify-reset
 * @desc    Verify OTP and reset password
 * @access  Admin only
 * @body    otp, newPassword
 */
const verifyOTPAndResetPassword = async (req, res) => {
  try {
    const { id } = req.params;
    const { otp, newPassword } = req.body;
    const adminId = req.userId;
    const storefront = storefrontFromScope(req);
    const scopeFilter =
      storefront === 'wholesale'
        ? { allowedStorefronts: 'wholesale' }
        : {
            $or: [
              { allowedStorefronts: 'ecomm' },
              { allowedStorefronts: { $exists: false } },
              { allowedStorefronts: [] }
            ]
          };

    // Input validation
    if (!otp || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'OTP and new password are required'
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 6 characters'
      });
    }

    if (!/^\d{6}$/.test(otp)) {
      return res.status(400).json({
        success: false,
        message: 'OTP must be a 6-digit number'
      });
    }

    // Check Redis availability
    if (!redisManager.isReady()) {
      return res.status(503).json({
        success: false,
        message: 'Service temporarily unavailable. Please try again later.',
        code: 'REDIS_UNAVAILABLE'
      });
    }

    // Verify OTP
    const isValid = await verifyOTP(adminId, id, otp);
    if (!isValid) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired OTP. Please request a new one.'
      });
    }

    // Get staff
    const staff = await User.findOne({ _id: id, ...scopeFilter });
    if (!staff) {
      return res.status(404).json({
        success: false,
        message: 'Staff not found'
      });
    }

    // Get admin for confirmation email
    const admin = await User.findById(adminId).select('email name');
    
    // Update staff password (model will hash it)
    staff.password = newPassword;
    await staff.save();

    // Send confirmation email to admin (non-blocking — never delay success response)
    if (admin?.email) {
      const to = admin.email;
      const name = admin.name;
      const staffName = staff.name;
      enqueueBackgroundEmail('staff reset confirmation email failed', () =>
        sendResetConfirmation(to, name, staffName)
      );
    }

    return res.status(200).json({
      success: true,
      message: `Password reset successfully for ${staff.name}`
    });
  } catch (error) {
    console.error('[StaffController] verifyOTPAndResetPassword Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to reset password',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * @route   DELETE /api/admin/staff/:id
 * @desc    Delete staff member
 * @access  Admin only
 */
const deleteStaff = async (req, res) => {
  try {
    const { id } = req.params;
    const storefront = storefrontFromScope(req);
    const scopeFilter =
      storefront === 'wholesale'
        ? { allowedStorefronts: 'wholesale' }
        : {
            $or: [
              { allowedStorefronts: 'ecomm' },
              { allowedStorefronts: { $exists: false } },
              { allowedStorefronts: [] }
            ]
          };

    if (id === req.userId) {
      return res.status(403).json({
        success: false,
        message: 'Cannot delete your own account'
      });
    }

    const staff = await User.findOneAndDelete({ _id: id, ...scopeFilter });
    if (!staff) {
      return res.status(404).json({
        success: false,
        message: 'Staff not found'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Staff deleted successfully'
    });
  } catch (error) {
    console.error('[StaffController] deleteStaff Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete staff',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * @route   GET /api/admin/staff/profile/me
 * @desc    Get admin's own profile
 * @access  Admin only
 */
const getAdminProfile = async (req, res) => {
  try {
    const admin = await User.findById(req.userId)
      .select('name email phone role userType status createdAt updatedAt')
      .lean();

    if (!admin) {
      return res.status(404).json({
        success: false,
        message: 'Admin not found'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Profile fetched successfully',
      data: {
        id: admin._id,
        name: admin.name,
        email: admin.email,
        phone: admin.phone,
        role: admin.role,
        userType: admin.userType,
        status: admin.status,
        createdAt: admin.createdAt,
        updatedAt: admin.updatedAt
      }
    });
  } catch (error) {
    console.error('[StaffController] getAdminProfile Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch profile',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * @route   POST /api/admin/staff/profile/me/initiate-password-reset
 * @desc    Send OTP to logged-in admin email for self password reset (storefront-scoped)
 * @access  Admin only
 */
const initiateSelfPasswordReset = async (req, res) => {
  try {
    const adminId = String(req.userId || '').trim();
    const storefront = storefrontFromScope(req);

    if (!adminId) {
      return res.status(401).json({
        success: false,
        code: 'UNAUTHORIZED',
        message: 'Authentication required'
      });
    }

    if (!redisManager.isReady()) {
      return res.status(503).json({
        success: false,
        code: 'REDIS_UNAVAILABLE',
        message: 'Service temporarily unavailable. Please try again later.'
      });
    }

    const client = redisManager.getClient();
    const rateKey = selfResetRateKey(storefront, adminId);
    let sendCount = 0;
    try {
      sendCount = await client.incr(rateKey);
      if (sendCount === 1) {
        await client.expire(rateKey, SELF_RESET_OTP_SEND_WINDOW_SECONDS);
      }
    } catch (rateErr) {
      console.error('[StaffController] self-reset rate limit error:', rateErr?.message || rateErr);
      return res.status(503).json({
        success: false,
        code: 'REDIS_UNAVAILABLE',
        message: 'Service temporarily unavailable. Please try again later.'
      });
    }

    if (sendCount > SELF_RESET_OTP_SEND_LIMIT) {
      return res.status(429).json({
        success: false,
        code: 'SELF_RESET_RATE_LIMITED',
        message: 'Too many password reset requests. Please try again after some time.'
      });
    }

    const admin = await User.findById(adminId).select('name email role status');
    if (!admin) {
      return res.status(404).json({
        success: false,
        code: 'ADMIN_NOT_FOUND',
        message: 'Admin not found'
      });
    }

    if (String(admin.role || '').toLowerCase() !== 'admin') {
      return res.status(403).json({
        success: false,
        code: 'FORBIDDEN',
        message: 'Only admin accounts can reset password from profile.'
      });
    }

    if (String(admin.status || '').toLowerCase() === 'inactive') {
      return res.status(403).json({
        success: false,
        code: 'ACCOUNT_INACTIVE',
        message: 'Inactive accounts cannot reset password.'
      });
    }

    const email = String(admin.email || '').trim();
    if (!email || !email.includes('@')) {
      return res.status(400).json({
        success: false,
        code: 'ADMIN_EMAIL_MISSING',
        message: 'No valid email on your admin account. Contact support.'
      });
    }

    const otp = generateOTP();
    try {
      await client.setEx(selfResetOtpKey(storefront, adminId), OTP_EXPIRY_SECONDS, otp);
      await client.del(selfResetFailKey(storefront, adminId));
    } catch (storeErr) {
      console.error('[StaffController] self-reset OTP store error:', storeErr?.message || storeErr);
      return res.status(503).json({
        success: false,
        code: 'REDIS_UNAVAILABLE',
        message: 'Service temporarily unavailable. Please try again later.'
      });
    }

    try {
      await sendSelfPasswordResetOTP(email, admin.name, otp, storefront);
    } catch (mailErr) {
      console.error('[StaffController] self-reset email failed:', mailErr?.message || mailErr);
      try {
        await client.del(selfResetOtpKey(storefront, adminId));
      } catch (_) {
        /* ignore */
      }
      const notConfigured = mailErr?.code === 'EMAIL_NOT_CONFIGURED';
      return res.status(502).json({
        success: false,
        code: notConfigured ? 'EMAIL_NOT_CONFIGURED' : 'EMAIL_SEND_FAILED',
        message: notConfigured
          ? 'Email is not configured on the server. Contact support.'
          : 'Could not send OTP email. Please try again later.'
      });
    }

    return res.status(200).json({
      success: true,
      message: `OTP sent to ${maskEmail(email)}. Valid for ${OTP_EXPIRY_SECONDS / 60} minutes.`,
      data: {
        expiresInSeconds: OTP_EXPIRY_SECONDS,
        maskedEmail: maskEmail(email),
        storefront
      }
    });
  } catch (error) {
    console.error('[StaffController] initiateSelfPasswordReset Error:', error);
    return res.status(500).json({
      success: false,
      code: 'SELF_RESET_INIT_FAILED',
      message: 'Failed to initiate password reset',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * @route   POST /api/admin/staff/profile/me/verify-password-reset
 * @desc    Verify OTP and set new password for logged-in admin (storefront-scoped)
 * @access  Admin only
 * @body    otp, newPassword, confirmPassword?
 */
const verifySelfPasswordReset = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: errors.array()[0]?.msg || 'Invalid input',
        errors: errors.array()
      });
    }

    const adminId = String(req.userId || '').trim();
    const storefront = storefrontFromScope(req);
    const otp = String(req.body.otp || '').replace(/\D/g, '').slice(0, 6);
    const newPassword = String(req.body.newPassword || '');
    const confirmPassword =
      req.body.confirmPassword != null ? String(req.body.confirmPassword) : null;

    if (!adminId) {
      return res.status(401).json({
        success: false,
        code: 'UNAUTHORIZED',
        message: 'Authentication required'
      });
    }

    if (!otp || !newPassword) {
      return res.status(400).json({
        success: false,
        code: 'PAYLOAD_INVALID',
        message: 'OTP and new password are required'
      });
    }

    if (!/^\d{6}$/.test(otp)) {
      return res.status(400).json({
        success: false,
        code: 'OTP_FORMAT_INVALID',
        message: 'OTP must be a 6-digit number'
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        code: 'PASSWORD_TOO_SHORT',
        message: 'Password must be at least 6 characters'
      });
    }

    if (confirmPassword != null && confirmPassword !== newPassword) {
      return res.status(400).json({
        success: false,
        code: 'PASSWORD_MISMATCH',
        message: 'New password and confirmation do not match'
      });
    }

    if (!redisManager.isReady()) {
      return res.status(503).json({
        success: false,
        code: 'REDIS_UNAVAILABLE',
        message: 'Service temporarily unavailable. Please try again later.'
      });
    }

    // Load admin BEFORE consuming OTP so validation failures keep the OTP usable.
    const admin = await User.findById(adminId).select('+password name email role status');
    if (!admin) {
      return res.status(404).json({
        success: false,
        code: 'ADMIN_NOT_FOUND',
        message: 'Admin not found'
      });
    }

    if (String(admin.role || '').toLowerCase() !== 'admin') {
      return res.status(403).json({
        success: false,
        code: 'FORBIDDEN',
        message: 'Only admin accounts can reset password from profile.'
      });
    }

    try {
      if (admin.password && (await admin.comparePassword(newPassword))) {
        return res.status(400).json({
          success: false,
          code: 'PASSWORD_UNCHANGED',
          message: 'New password must be different from your current password. OTP is still valid — enter a different password.'
        });
      }
    } catch (_) {
      /* no prior password / compare edge — allow set */
    }

    const client = redisManager.getClient();
    const otpKey = selfResetOtpKey(storefront, adminId);
    const failKey = selfResetFailKey(storefront, adminId);

    let storedOTP = null;
    try {
      storedOTP = redisValueToString(await client.get(otpKey));
    } catch (redisErr) {
      console.error('[StaffController] self-reset OTP read error:', redisErr?.message || redisErr);
      return res.status(503).json({
        success: false,
        code: 'REDIS_UNAVAILABLE',
        message: 'Service temporarily unavailable. Please try again later.'
      });
    }

    if (!storedOTP) {
      return res.status(400).json({
        success: false,
        code: 'OTP_EXPIRED',
        message: 'OTP expired or was already used. Please request a new OTP.'
      });
    }

    if (!otpsEqual(storedOTP, otp)) {
      let failCount = 0;
      try {
        failCount = await client.incr(failKey);
        if (failCount === 1) {
          await client.expire(failKey, OTP_EXPIRY_SECONDS);
        }
        if (failCount >= SELF_RESET_OTP_FAIL_LIMIT) {
          await client.del(otpKey);
          await client.del(failKey);
          return res.status(400).json({
            success: false,
            code: 'OTP_LOCKED',
            message: 'Too many invalid OTP attempts. Please request a new OTP.'
          });
        }
      } catch (_) {
        /* non-blocking fail counter */
      }

      return res.status(400).json({
        success: false,
        code: 'OTP_INVALID',
        message: 'Incorrect OTP. Please check the latest email and try again.'
      });
    }

    // Persist password first — only then consume OTP (avoids burning OTP on save failure).
    admin.password = newPassword;
    try {
      await admin.save();
    } catch (saveErr) {
      console.error('[StaffController] self-reset save error:', saveErr?.message || saveErr);
      return res.status(500).json({
        success: false,
        code: 'PASSWORD_SAVE_FAILED',
        message: 'Failed to update password. Your OTP is still valid — try again.'
      });
    }

    try {
      await client.del(otpKey);
      await client.del(failKey);
    } catch (delErr) {
      console.error('[StaffController] self-reset OTP cleanup error:', delErr?.message || delErr);
      /* password already saved — do not fail the request */
    }

    // Confirmation email must NEVER block the success response (SMTP hang → client timeout).
    if (admin.email) {
      const to = String(admin.email);
      const name = admin.name;
      const sf = storefront;
      enqueueBackgroundEmail('self-reset confirmation email failed', () =>
        sendSelfPasswordResetConfirmation(to, name, sf)
      );
    }

    return res.status(200).json({
      success: true,
      message: 'Password updated successfully. Use your new password next time you sign in.',
      data: { storefront }
    });
  } catch (error) {
    console.error('[StaffController] verifySelfPasswordReset Error:', error);
    return res.status(500).json({
      success: false,
      code: 'SELF_RESET_VERIFY_FAILED',
      message: 'Failed to reset password',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * @route   PUT /api/admin/staff/profile/me
 * @desc    Update admin's own profile (name, phone only)
 * @access  Admin only
 * @body    name, phone (both optional)
 */
const updateOwnProfile = async (req, res) => {
  try {
    const { name, phone } = req.body;

    const updates = {};
    if (name) updates.name = name;
    if (phone) updates.phone = phone;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No fields to update'
      });
    }

    const admin = await User.findByIdAndUpdate(
      req.userId,
      { $set: updates },
      {  returnDocument: 'after', runValidators: true }
    ).select('name email phone role userType status');

    if (!admin) {
      return res.status(404).json({
        success: false,
        message: 'Admin not found'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Profile updated successfully',
      data: admin
    });
  } catch (error) {
    console.error('[StaffController] updateOwnProfile Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update profile',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// ==============================
// MODULE EXPORTS
// ==============================

module.exports = {
  // Staff CRUD
  getAllStaff,
  createStaff,
  getStaffById,
  updateStaff,
  deleteStaff,
  
  // Password reset (staff)
  initiatePasswordReset,
  verifyOTPAndResetPassword,

  // Admin self password reset (profile)
  initiateSelfPasswordReset,
  verifySelfPasswordReset,
  
  // Profile management
  getAdminProfile,
  updateOwnProfile
};