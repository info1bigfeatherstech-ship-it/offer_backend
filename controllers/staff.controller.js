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
const nodemailer = require('nodemailer');
const redisManager = require('../config/redis.config');

// ==============================
// CONSTANTS & CONFIGURATION
// ==============================

/** Allowed roles for staff members (admin only) */
const ALLOWED_STAFF_ROLES = ['product_manager', 'order_manager', 'marketing_manager'];

/** OTP expiration time in seconds (10 minutes) */
const OTP_EXPIRY_SECONDS = 600;

/** OTP length (6 digits) */
const OTP_LENGTH = 6;

/** Email configuration */
const EMAIL_FROM = process.env.EMAIL_USER;

// ==============================
// EMAIL TRANSPORTER
// ==============================

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
  }
});

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

  await transporter.sendMail(mailOptions);
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
  await transporter.sendMail(mailOptions);
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
    const storefront = storefrontFromScope(req);

    if (!ALLOWED_STAFF_ROLES.includes(role)) {
      return res.status(400).json({
        success: false,
        message: `Invalid role. Allowed roles: ${ALLOWED_STAFF_ROLES.join(', ')}`
      });
    }

    const [existingEmail, existingPhone] = await Promise.all([
      User.findOne({ email }),
      User.findOne({ phone })
    ]);

    if (existingEmail) {
      return res.status(409).json({
        success: false,
        message: 'User with this email already exists'
      });
    }

    if (existingPhone) {
      return res.status(409).json({
        success: false,
        message: 'User with this phone number already exists'
      });
    }

    const staff = new User({
      name,
      email,
      phone,
      password,
      role,
      userType: 'user',
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

    // Send confirmation email to admin
    if (admin) {
      await sendResetConfirmation(admin.email, admin.name, staff.name);
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
  
  // Password reset
  initiatePasswordReset,
  verifyOTPAndResetPassword,
  
  // Profile management
  getAdminProfile,
  updateOwnProfile
};