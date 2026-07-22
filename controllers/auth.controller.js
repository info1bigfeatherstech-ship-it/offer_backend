const User = require('../models/User');
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { validationResult } = require('express-validator');
const redisManager = require('../config/redis.config');
const tokenStore = require('../config/tokenBlacklist');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { normalizeAllowedStorefronts } = require('../middlewares/admin-storefront-scope.middleware');
const { getRefreshCookieOptions } = require('../utils/refreshCookieOptions');
const refreshTokenSession = require('../services/refreshTokenSession.service');

// Import from OTP service
const {
  sendOTP,
  generateOTP,
  deliverOtpFor,
  validateRecipientsForMode,
  getDeliveryMode,
  OTP_DELIVERY_MODES,
  getOtpExpiryMs
} = require("../services/otp.service");

// ========== HELPERS ==========

/**
 * LEGACY helper kept for any internal caller that only had a phone in hand.
 * Now routes through env-aware delivery layer.
 *
 * Prefer `deliverRegistrationStyleOTP({ phone, email, otp, purpose })` below
 * for new flows so email-mode actually works.
 */
const sendPhoneOTP = async (phone, otp) => {
  try {
    await sendOTP(phone, otp);
    console.log(` OTP sent to ${phone}`);
    return true;
  } catch (error) {
    console.error(` Failed to send OTP to ${phone}:`, error.message);
    throw error;
  }
};

/**
 * Build a frontend-friendly "OTP sent to ..." message from the delivery
 * result. Never throws — pure string formatter.
 */
const describeOtpDelivery = (delivery) => {
  if (!delivery || !Array.isArray(delivery.deliveredVia) || delivery.deliveredVia.length === 0) {
    return 'OTP sent';
  }
  if (delivery.deliveredVia.length === 2) return 'OTP sent to your phone and email';
  if (delivery.deliveredVia[0] === 'email') return 'OTP sent to your email';
  return 'OTP sent to your phone number';
};

// Helper to extract token from Authorization header
const getTokenFromHeader = (req) => {
  const authHeader = req.headers.authorization || '';
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
};

// Configure nodemailer
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
  }
});

// ========== TOKEN GENERATION ==========

if (!process.env.JWT_SECRET || !process.env.REFRESH_TOKEN_SECRET) {
  throw new Error('JWT secrets are not configured');
}

const ACCESS_EXPIRES = process.env.ACCESS_TOKEN_EXPIRES || '15m';
const REFRESH_EXPIRES = process.env.REFRESH_TOKEN_EXPIRES || '7d';
// Contact-change OTP shares the global expiry window so all OTP flows stay
// in lockstep. Change via OTP_EXPIRY_MINUTES env.
const CONTACT_CHANGE_OTP_TTL_MS = getOtpExpiryMs();
const CONTACT_CHANGE_MAX_ATTEMPTS = 5;
const PASSWORD_RESET_TOKEN_EXPIRES = '10m';
const PASSWORD_RESET_TOKEN_TTL_SECONDS = 10 * 60;
const PASSWORD_RESET_FIND_MAX_ATTEMPTS = 3;
const PASSWORD_RESET_FIND_WINDOW_SECONDS = 24 * 60 * 60;
const PASSWORD_RESET_FIND_GENERIC_MESSAGE =
  'If this phone number is registered with us, you can continue to reset your password.';
const PRIVILEGED_OPERATIONAL_ROLES = new Set(['admin', 'product_manager', 'order_manager', 'marketing_manager']);
const SUPPORTED_LOGIN_PORTALS = new Set(['ecomm', 'wholesale', 'admin-ecomm', 'admin-wholesale']);
const respondAuthError = (res, statusCode, code, message, extras = {}) =>
  res.status(statusCode).json({
    success: false,
    code,
    message,
    ...extras
  });
const REFRESH_COOKIE_BY_PORTAL = {
  ecomm: 'refreshToken_ecomm',
  wholesale: 'refreshToken_wholesale',
  'admin-ecomm': 'refreshToken_admin_ecomm',
  'admin-wholesale': 'refreshToken_admin_wholesale'
};

const generateAccessToken = (userId, userType = 'user', role = 'user', portal = null) => {
  return jwt.sign(
    { id: userId, type: 'access', userType, role, portal: portal || undefined },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_EXPIRES }
  );
};

const generateRefreshToken = (userId) => {
  return jwt.sign(
    { id: userId, type: 'refresh', jti: crypto.randomUUID() },
    process.env.REFRESH_TOKEN_SECRET,
    { expiresIn: REFRESH_EXPIRES }
  );
};

const hashToken = refreshTokenSession.hashRefreshToken;

const getPasswordResetFindKey = (phone) => `pwd_reset_find:${phone}`;
const getPasswordResetTokenKey = (jti) => `pwd_reset_token:${jti}`;

/**
 * Phone-scoped daily attempt counter for Option D forgot-password find-user.
 * Fail-closed when Redis is unavailable so abuse cannot bypass the limit.
 */
const consumePasswordResetFindAttempt = async (phone) => {
  if (!redisManager.isReady()) {
    const err = new Error('Password reset rate-limit service unavailable');
    err.code = 'RATE_LIMIT_UNAVAILABLE';
    throw err;
  }

  const redis = redisManager.getClient();
  const key = getPasswordResetFindKey(phone);
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, PASSWORD_RESET_FIND_WINDOW_SECONDS);
  }

  return {
    allowed: count <= PASSWORD_RESET_FIND_MAX_ATTEMPTS,
    count,
    maxAttempts: PASSWORD_RESET_FIND_MAX_ATTEMPTS
  };
};

const clearPasswordResetFindAttempts = async (phone) => {
  if (!phone || !redisManager.isReady()) return;
  try {
    await redisManager.getClient().del(getPasswordResetFindKey(phone));
  } catch (err) {
    console.error('[ForgotPassword] Failed clearing find-user rate limit:', err?.message || err);
  }
};

const issuePasswordResetToken = async (userId) => {
  if (!redisManager.isReady()) {
    const err = new Error('Password reset token service unavailable');
    err.code = 'RESET_TOKEN_STORE_UNAVAILABLE';
    throw err;
  }

  const jti = crypto.randomUUID();
  const resetToken = jwt.sign(
    { id: userId, type: 'password_reset', jti },
    process.env.JWT_SECRET,
    { expiresIn: PASSWORD_RESET_TOKEN_EXPIRES }
  );

  await redisManager.getClient().setEx(
    getPasswordResetTokenKey(jti),
    PASSWORD_RESET_TOKEN_TTL_SECONDS,
    String(userId)
  );

  return resetToken;
};

const consumePasswordResetToken = async (resetToken) => {
  let decoded;
  try {
    decoded = jwt.verify(resetToken, process.env.JWT_SECRET);
  } catch (err) {
    if (err?.name === 'TokenExpiredError') {
      const expiredErr = new Error('Reset token has expired. Please start again.');
      expiredErr.code = 'RESET_TOKEN_EXPIRED';
      throw expiredErr;
    }
    const invalidErr = new Error('Reset token is invalid. Please start again.');
    invalidErr.code = 'RESET_TOKEN_INVALID';
    throw invalidErr;
  }

  if (!decoded || decoded.type !== 'password_reset' || !decoded.id || !decoded.jti) {
    const invalidErr = new Error('Reset token is invalid. Please start again.');
    invalidErr.code = 'RESET_TOKEN_INVALID';
    throw invalidErr;
  }

  if (!redisManager.isReady()) {
    const err = new Error('Password reset token service unavailable');
    err.code = 'RESET_TOKEN_STORE_UNAVAILABLE';
    throw err;
  }

  const redis = redisManager.getClient();
  const key = getPasswordResetTokenKey(decoded.jti);
  const storedUserId = await redis.get(key);
  if (!storedUserId || String(storedUserId) !== String(decoded.id)) {
    const invalidErr = new Error('Reset token is invalid or already used. Please start again.');
    invalidErr.code = 'RESET_TOKEN_INVALID';
    throw invalidErr;
  }

  await redis.del(key);
  return decoded;
};

/**
 * Fire-and-forget informational email after a successful password change.
 * Never throws to the caller — email failure must not block password reset.
 */
const sendPasswordChangedNotificationEmail = async (user) => {
  const email = String(user?.email || '').trim().toLowerCase();
  if (!email) return;

  try {
    await transporter.sendMail({
      from: `"OfferWaleBaba" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'Your password was changed — OfferWaleBaba',
      text:
        `Hi ${user.name || 'there'},\n\n` +
        'Your OfferWaleBaba account password was changed successfully.\n\n' +
        'If you made this change, no further action is needed.\n' +
        'If you did not change your password, please change your password immediately or contact Support Team.\n\n' +
        '— OfferWaleBaba',
      html:
        `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;padding:24px;border:1px solid #eee;border-radius:8px;">` +
        `<h2 style="margin:0 0 8px 0;color:#222;">Password changed</h2>` +
        `<p style="color:#555;line-height:1.5;">Hi ${user.name || 'there'},</p>` +
        `<p style="color:#555;line-height:1.5;">Your OfferWaleBaba account password was changed successfully.</p>` +
        `<p style="color:#555;line-height:1.5;">If you made this change, no further action is needed. If you did not change your password, please change Password or contact Support Team.</p>` +
        `<p style="color:#aaa;font-size:12px;margin-top:24px;">— OfferWaleBaba</p>` +
        `</div>`
    });
  } catch (err) {
    console.error('[ForgotPassword] Password-changed email failed:', err?.message || err);
  }
};

const normalizePortal = (rawPortal) => {
  const normalized = String(rawPortal || '').trim().toLowerCase();
  if (!normalized) return '';
  return normalized;
};

const normalizeRefreshPortal = (rawPortal) => {
  const portal = normalizePortal(rawPortal);
  return SUPPORTED_LOGIN_PORTALS.has(portal) ? portal : '';
};

const normalizeContactField = (rawField) => {
  const normalized = String(rawField || '').trim().toLowerCase();
  return normalized === 'email' || normalized === 'phone' ? normalized : '';
};

const resolveRefreshCookieName = (portal) => {
  return REFRESH_COOKIE_BY_PORTAL[normalizeRefreshPortal(portal)] || REFRESH_COOKIE_BY_PORTAL.ecomm;
};

const setRefreshTokenCookie = (req, res, portal, refreshToken) => {
  const cookieName = resolveRefreshCookieName(portal);
  const opts = getRefreshCookieOptions(req);
  res.cookie(cookieName, refreshToken, opts);
  if (cookieName !== 'refreshToken') {
    res.clearCookie('refreshToken', opts);
  }
  return cookieName;
};

const clearRefreshTokenCookie = (req, res, portal) => {
  const cookieName = resolveRefreshCookieName(portal);
  const opts = getRefreshCookieOptions(req);
  res.clearCookie(cookieName, opts);
  if (cookieName !== 'refreshToken') {
    res.clearCookie('refreshToken', opts);
  }
};

/** Logout / legacy: first matching scoped cookie (portal-specific). */
const readRefreshTokenFromRequest = (req, portal) => {
  const cookieName = resolveRefreshCookieName(portal);
  const scopedCookie = req.cookies?.[cookieName];
  if (scopedCookie) {
    return { refreshToken: scopedCookie, cookieName };
  }

  const knownScopedCookies = Object.values(REFRESH_COOKIE_BY_PORTAL);
  for (const knownName of knownScopedCookies) {
    const candidate = req.cookies?.[knownName];
    if (candidate) {
      return { refreshToken: candidate, cookieName: knownName };
    }
  }

  const legacyCookie = req.cookies?.refreshToken;
  if (legacyCookie) {
    return { refreshToken: legacyCookie, cookieName: 'refreshToken' };
  }
  return { refreshToken: null, cookieName };
};

/**
 * Refresh flow: ONLY cookies for the requested portal (never cross-mix admin ↔ customer).
 * Prevents admin panel from silently inheriting a customer refreshToken_ecomm session.
 */
const REFRESH_COOKIES_BY_PORTAL = {
  ecomm: ['refreshToken_ecomm', 'refreshToken'],
  wholesale: ['refreshToken_wholesale'],
  'admin-ecomm': ['refreshToken_admin_ecomm'],
  'admin-wholesale': ['refreshToken_admin_wholesale']
};

const listRefreshCookieCandidates = (req, preferredPortal) => {
  const portal = normalizeRefreshPortal(preferredPortal) || 'ecomm';
  const cookieNames = REFRESH_COOKIES_BY_PORTAL[portal] || REFRESH_COOKIES_BY_PORTAL.ecomm;
  const candidates = [];

  for (const cookieName of cookieNames) {
    const value = req.cookies?.[cookieName];
    if (value) {
      candidates.push({ refreshToken: value, cookieName });
    }
  }

  return candidates;
};

const resolveRefreshSession = (refreshToken) => refreshTokenSession.lookupSession(refreshToken);

const isPrivilegedRole = (role) => {
  return PRIVILEGED_OPERATIONAL_ROLES.has(String(role || '').trim().toLowerCase());
};

const isPrivilegedAccount = (user) => {
  if (!user) return false;
  const userType = String(user.userType || '').trim().toLowerCase();
  if (userType === 'admin') return true;
  return isPrivilegedRole(user.role);
};

const buildLoginUserLookup = (identifier, portal) => {
  const trimmedIdentifier = String(identifier || '').trim();
  const query = {
    $or: [{ email: trimmedIdentifier }, { phone: trimmedIdentifier }]
  };

  if (portal === 'admin-ecomm' || portal === 'admin-wholesale') {
    const requestedStorefront = portal === 'admin-wholesale' ? 'wholesale' : 'ecomm';
    query.$and = [
      {
        $or: [
          { userType: 'admin' },
          { role: { $in: Array.from(PRIVILEGED_OPERATIONAL_ROLES) } }
        ]
      },
      {
        $or: [
          { allowedStorefronts: requestedStorefront },
          { allowedStorefronts: { $exists: false } },
          { allowedStorefronts: [] }
        ]
      }
    ];
  } else if (portal === 'wholesale') {
    query.$and = [
      {
        $or: [{ userType: 'wholesaler' }, { role: 'wholesaler' }]
      }
    ];
  }

  return query;
};

const canLoginForPortal = (user, portal) => {
  if (!portal) {
    return {
      allowed: !isPrivilegedAccount(user),
      code: 'PORTAL_REQUIRED_FOR_PRIVILEGED_ACCOUNT',
      message: 'Privileged accounts must login from an explicit admin portal.'
    };
  }

  if (!SUPPORTED_LOGIN_PORTALS.has(portal)) {
    return {
      allowed: false,
      code: 'INVALID_PORTAL',
      message: `Unsupported portal "${portal}".`
    };
  }

  const privileged = isPrivilegedAccount(user);
  const normalizedAllowedStorefronts = normalizeAllowedStorefronts(user.allowedStorefronts);

  if (portal === 'ecomm') {
    if (privileged) {
      return {
        allowed: false,
        code: 'PORTAL_ACCESS_DENIED',
        message: 'This account is not allowed to login from the ecomm user portal.'
      };
    }
    return { allowed: true };
  }

  if (portal === 'wholesale') {
    const isWholesaler =
      String(user.userType || '').trim().toLowerCase() === 'wholesaler' ||
      String(user.role || '').trim().toLowerCase() === 'wholesaler';
    if (!isWholesaler || privileged) {
      return {
        allowed: false,
        code: 'PORTAL_ACCESS_DENIED',
        message: 'This account is not allowed to login from the wholesale user portal.'
      };
    }
    return { allowed: true };
  }

  if (portal === 'admin-ecomm') {
    if (!privileged) {
      return {
        allowed: false,
        code: 'PORTAL_ACCESS_DENIED',
        message: 'This account is not allowed to login from the ecomm admin portal.'
      };
    }
    if (!normalizedAllowedStorefronts.includes('ecomm')) {
      return {
        allowed: false,
        code: 'PORTAL_ACCESS_DENIED',
        message: 'This account is not allowed to login from the ecomm admin portal.'
      };
    }
    return { allowed: true };
  }

  if (portal === 'admin-wholesale') {
    if (!privileged) {
      return {
        allowed: false,
        code: 'PORTAL_ACCESS_DENIED',
        message: 'This account is not allowed to login from the wholesale admin portal.'
      };
    }
    if (!normalizedAllowedStorefronts.includes('wholesale')) {
      return {
        allowed: false,
        code: 'PORTAL_ACCESS_DENIED',
        message: 'This account is not allowed to login from the wholesale admin portal.'
      };
    }
    return { allowed: true };
  }

  return {
    allowed: false,
    code: 'INVALID_PORTAL',
    message: `Unsupported portal "${portal}".`
  };
};

// Google OAuth2 client
const googleClient = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID || 'NO_CLIENT_ID_SET'
);

const isVerifiedUserRecord = (user) => Boolean(user && (user.isPhoneVerified || user.isEmailVerified));

const buildRegisterLoginPayload = (user, accessToken) => ({
  success: true,
  message: "Registration successful",
  accessToken,
  user: {
    id: user._id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    userType: user.userType,
    role: user.role,
    status: user.status,
    isPhoneVerified: user.isPhoneVerified,
    isEmailVerified: user.isEmailVerified,
    isProfileComplete: user.isProfileComplete
  }
});

// ========== 1️ REGISTER CONTROLLER ==========

const register = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return respondAuthError(res, 400, 'VALIDATION_FAILED', 'Validation failed', {
        errors: errors.array()
      });
    }

    const { email, password, name, phone } = req.body;

    const normalizedEmail = String(email || '').trim().toLowerCase();
    const normalizedPhone = String(phone || '').trim();

    /*
      Legacy OTP registration flow intentionally preserved here for safe rollback:

      1. validateRecipientsForMode({ phone, email })
      2. reject only if an existing VERIFIED email/phone user already existed
      3. reuse/update one unverified user record
      4. generate OTP + persist in both email/phone OTP fields
      5. deliver OTP via configured delivery mode
      6. return { requiresOTPVerification: true } without access token

      New production flow:
      - no OTP generation/delivery
      - register response immediately authenticates the user
      - legacy abandoned/unverified records are safely upgraded in place
      - conflicting abandoned records (email hits one orphan, phone hits another)
        are rejected with ACCOUNT_CONFLICT instead of unsafe auto-merge
    */

    const [existingPhoneUser, existingEmailUser] = await Promise.all([
      User.findOne({ phone: normalizedPhone }).select(
        "+phoneVerificationOTP +phoneVerificationOTPExpires +emailVerificationOTP +emailVerificationOTPExpires name email phone userType role isPhoneVerified isEmailVerified status isProfileComplete registrationMethod"
      ),
      normalizedEmail
        ? User.findOne({ email: normalizedEmail }).select(
            "+phoneVerificationOTP +phoneVerificationOTPExpires +emailVerificationOTP +emailVerificationOTPExpires name email phone userType role isPhoneVerified isEmailVerified status isProfileComplete registrationMethod"
          )
        : Promise.resolve(null)
    ]);

    if (existingPhoneUser && isVerifiedUserRecord(existingPhoneUser)) {
      return respondAuthError(res, 409, 'PHONE_ALREADY_REGISTERED', 'User with this phone number already exists. Please login.');
    }

    if (existingEmailUser && isVerifiedUserRecord(existingEmailUser)) {
      return respondAuthError(res, 409, 'EMAIL_ALREADY_REGISTERED', 'User with this email already exists. Please login.');
    }

    const phoneOrphan = existingPhoneUser && !isVerifiedUserRecord(existingPhoneUser) ? existingPhoneUser : null;
    const emailOrphan = existingEmailUser && !isVerifiedUserRecord(existingEmailUser) ? existingEmailUser : null;

    if (phoneOrphan && emailOrphan && !phoneOrphan._id.equals(emailOrphan._id)) {
      return respondAuthError(
        res,
        409,
        'ACCOUNT_CONFLICT',
        'This email and phone number are associated with different incomplete accounts. Please contact support or use a different email/phone combination.'
      );
    }

    const user = phoneOrphan || emailOrphan || new User({
      userType: 'user',
      role: 'user'
    });

    user.name = name;
    user.email = normalizedEmail || undefined;
    user.phone = normalizedPhone;
    user.password = password;
    user.userType = user.userType || 'user';
    user.role = user.role || 'user';
    user.status = 'active';
    user.isPhoneVerified = true;
    user.isEmailVerified = Boolean(normalizedEmail);
    user.isProfileComplete = true;
    user.registrationMethod = 'phone';
    user.phoneVerificationOTP = undefined;
    user.phoneVerificationOTPExpires = undefined;
    user.emailVerificationOTP = undefined;
    user.emailVerificationOTPExpires = undefined;

    await user.save();

    const accessToken = generateAccessToken(user._id, user.userType, user.role, 'ecomm');
    const refreshToken = generateRefreshToken(user._id);
    const hashedRefreshToken = hashToken(refreshToken);
    const deviceInfo = req.headers['user-agent'] || req.body.deviceInfo || 'Unknown';

    await refreshTokenSession.appendSession(user._id, {
      hashedToken: hashedRefreshToken,
      deviceInfo
    });

    setRefreshTokenCookie(req, res, 'ecomm', refreshToken);

    return res.status(200).json(buildRegisterLoginPayload(user, accessToken));

  } catch (error) {
    console.error('Registration error:', error);
    return respondAuthError(res, 500, 'REGISTRATION_FAILED', 'Error during registration', { error: error.message });
  }
};





// ========== 2️ VERIFY OTP & LOGIN ==========

const verifyOTPAndLogin = async (req, res) => {
  try {
    // Backward compatible: accept legacy `phone` field OR new `identifier` field.
    // `identifier` may be a 10-digit phone OR an email — auto-detected.
    const rawIdentifier = String(req.body.identifier || req.body.phone || req.body.email || '').trim();
    const otpRaw = req.body.otp;

    if (!rawIdentifier || !otpRaw) {
      return respondAuthError(res, 400, 'PHONE_OTP_PAYLOAD_INVALID', 'Identifier (phone/email) and OTP are required');
    }

    const otpString = String(otpRaw).trim();
    const looksLikeEmail = rawIdentifier.includes('@');
    const looksLikePhone = /^\d{10}$/.test(rawIdentifier);

    if (!looksLikeEmail && !looksLikePhone) {
      return respondAuthError(res, 400, 'IDENTIFIER_INVALID', 'Identifier must be a 10-digit phone number or a valid email.');
    }

    // Build identifier-based lookup. Select both verification OTP fields since
    // the channel used at registration may differ from what we expect.
    const lookup = looksLikeEmail
      ? { email: rawIdentifier.toLowerCase() }
      : { phone: rawIdentifier };

    const user = await User.findOne(lookup).select(
      "+phoneVerificationOTP +phoneVerificationOTPExpires +emailVerificationOTP +emailVerificationOTPExpires +refreshTokens phone name email userType role isPhoneVerified status isEmailVerified isProfileComplete"
    );

    if (!user) {
      return respondAuthError(res, 404, 'USER_NOT_FOUND', `User not found with this ${looksLikeEmail ? 'email' : 'phone number'}`);
    }

    // If already verified (either channel), just login.
    if (user.isPhoneVerified || user.isEmailVerified) {
      const accessToken = generateAccessToken(user._id, user.userType, user.role);
      const refreshToken = generateRefreshToken(user._id);
      const hashedRefreshToken = hashToken(refreshToken);

      await refreshTokenSession.appendSession(user._id, {
        hashedToken: hashedRefreshToken
      });

      setRefreshTokenCookie(req, res, 'ecomm', refreshToken);

      return res.status(200).json({
        success: true,
        message: "Already verified. Logged in successfully.",
        accessToken,
        user: {
          id: user._id,
          email: user.email,
          name: user.name,
          phone: user.phone,
          userType: user.userType,
          isPhoneVerified: user.isPhoneVerified,
          isEmailVerified: user.isEmailVerified
        }
      });
    }

    // OTP match — accept either field (phone or email) since we wrote the
    // same OTP to both at registration time.
    const phoneOtpValid =
      user.phoneVerificationOTP &&
      user.phoneVerificationOTPExpires &&
      new Date() <= user.phoneVerificationOTPExpires &&
      user.phoneVerificationOTP === otpString;

    const emailOtpValid =
      user.emailVerificationOTP &&
      user.emailVerificationOTPExpires &&
      new Date() <= user.emailVerificationOTPExpires &&
      user.emailVerificationOTP === otpString;

    if (!phoneOtpValid && !emailOtpValid) {
      // Distinguish "expired" vs "wrong" for better UX:
      const hadAnyOtp =
        user.phoneVerificationOTP ||
        user.emailVerificationOTP;
      const allExpired =
        (!user.phoneVerificationOTPExpires || new Date() > user.phoneVerificationOTPExpires) &&
        (!user.emailVerificationOTPExpires || new Date() > user.emailVerificationOTPExpires);

      if (hadAnyOtp && allExpired) {
        return respondAuthError(res, 400, 'OTP_EXPIRED', 'OTP has expired. Please request a new OTP.');
      }
      return respondAuthError(res, 400, 'OTP_INVALID', 'Invalid OTP');
    }

    // Activate user. Set verification flag based on the lookup channel — the
    // identifier the user actually proved control of.
    if (looksLikeEmail) {
      user.isEmailVerified = true;
    } else {
      user.isPhoneVerified = true;
    }
    user.status = "active";
    user.isProfileComplete = true;
    user.phoneVerificationOTP = undefined;
    user.phoneVerificationOTPExpires = undefined;
    user.emailVerificationOTP = undefined;
    user.emailVerificationOTPExpires = undefined;
      
    // Generate tokens
    const accessToken = generateAccessToken(user._id, user.userType, user.role);
    const refreshToken = generateRefreshToken(user._id);
    const hashedRefreshToken = hashToken(refreshToken);

    const deviceInfo = req.headers['user-agent'] || req.body.deviceInfo || 'Unknown';

    await user.save();

    await refreshTokenSession.appendSession(user._id, {
      hashedToken: hashedRefreshToken,
      deviceInfo
    });

    setRefreshTokenCookie(req, res, 'ecomm', refreshToken);

    return res.status(200).json({
      success: true,
      message: "Phone verified successfully. You are now logged in.",
      accessToken,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        userType: user.userType,
        role: user.role,
        isPhoneVerified: user.isPhoneVerified,
        isEmailVerified: user.isEmailVerified,
        isProfileComplete: user.isProfileComplete
      }
    });

  } catch (error) {
    console.error("Verify OTP error:", error);
    return respondAuthError(res, 500, 'OTP_VERIFY_FAILED', 'Error verifying OTP', { error: error.message });
  }
};

// ========== 3️ LOGIN CONTROLLER (Email/Phone + Password) ==========

const login = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return respondAuthError(res, 400, 'VALIDATION_FAILED', 'Validation failed', {
        errors: errors.array()
      });
    }

    const { identifier, password } = req.body;
    const portal = normalizePortal(req.body.portal || req.headers['x-auth-portal']);

    const user = await User.findOne(buildLoginUserLookup(identifier, portal))
      .select("+password name email phone userType role allowedStorefronts isPhoneVerified isEmailVerified status isProfileComplete");

    if (!user) {
      return respondAuthError(res, 401, 'INVALID_CREDENTIALS', 'Invalid credentials');
    }

    // Account is considered verified if EITHER channel was verified at registration.
    // This keeps login working whether OTP_DELIVERY_MODE was sms, email, or both.
    if (!user.isPhoneVerified && !user.isEmailVerified) {
      return respondAuthError(res, 403, 'PHONE_NOT_VERIFIED', 'Account not verified. Please complete registration.');
    }

    if (user.status !== "active") {
      return respondAuthError(res, 403, 'ACCOUNT_INACTIVE', 'Your account is not active');
    }

    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      return respondAuthError(res, 401, 'INVALID_CREDENTIALS', 'Invalid credentials');
    }

    const portalDecision = canLoginForPortal(user, portal);
    if (!portalDecision.allowed) {
      const statusCode = portalDecision.code === 'INVALID_PORTAL' ? 400 : 403;
      return res.status(statusCode).json({
        success: false,
        code: portalDecision.code,
        message: portalDecision.message
      });
    }

const accessToken = generateAccessToken(user._id, user.userType, user.role, portal || null);
const refreshToken = generateRefreshToken(user._id);
const hashedRefreshToken = hashToken(refreshToken);

// Get device info from request headers
const deviceInfo = req.headers['user-agent'] || req.body.deviceInfo || 'Unknown';

await refreshTokenSession.appendSession(user._id, {
  hashedToken: hashedRefreshToken,
  deviceInfo
});

   setRefreshTokenCookie(req, res, portal || 'ecomm', refreshToken);


    return res.status(200).json({
      success: true,
      message: "Login successful",
      accessToken,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        phone: user.phone,
        userType: user.userType,
        role: user.role,
        status: user.status,
        isPhoneVerified: user.isPhoneVerified
      }
    });

  } catch (error) {
    console.error("Login error:", error);
    return respondAuthError(res, 500, 'LOGIN_FAILED', 'Error during login', { error: error.message });
  }
};

// ========== 4️ FORGOT PASSWORD - FIND USER (Option D, ecomm) ==========
//
// Production note:
// - Ecomm uses this direct phone + short-lived resetToken flow.
// - Legacy OTP handlers below are intentionally preserved (commented live wiring
//   remains active in routes for wholesaleFrontend compatibility + rollback).

const findUserForPasswordReset = async (req, res) => {
  try {
    const phone = String(req.body.phone || '').trim();

    if (!phone) {
      return respondAuthError(res, 400, 'PHONE_REQUIRED', 'Phone number is required');
    }

    if (!/^[0-9]{10}$/.test(phone)) {
      return respondAuthError(res, 400, 'INVALID_PHONE', 'Phone number must be exactly 10 digits');
    }

    let attempt;
    try {
      attempt = await consumePasswordResetFindAttempt(phone);
    } catch (rateErr) {
      console.error('[ForgotPassword] find-user rate-limit unavailable:', rateErr?.message || rateErr);
      return respondAuthError(
        res,
        503,
        rateErr?.code || 'RATE_LIMIT_UNAVAILABLE',
        'Password reset is temporarily unavailable. Please try again in a moment.'
      );
    }

    if (!attempt.allowed) {
      return respondAuthError(
        res,
        429,
        'RESET_ATTEMPTS_EXCEEDED',
        'Too many password reset attempts for this phone number. Please try again after 24 hours.'
      );
    }

    const user = await User.findOne({ phone }).select('_id phone email name status');

    // Generic response whether or not the account exists (anti-enumeration).
    // resetToken is only returned when a matching account is found.
    if (!user) {
      return res.status(200).json({
        success: true,
        message: PASSWORD_RESET_FIND_GENERIC_MESSAGE
      });
    }

    let resetToken;
    try {
      resetToken = await issuePasswordResetToken(user._id);
    } catch (tokenErr) {
      console.error('[ForgotPassword] reset token issue failed:', tokenErr?.message || tokenErr);
      return respondAuthError(
        res,
        503,
        tokenErr?.code || 'RESET_TOKEN_STORE_UNAVAILABLE',
        'Password reset is temporarily unavailable. Please try again in a moment.'
      );
    }

    return res.status(200).json({
      success: true,
      message: PASSWORD_RESET_FIND_GENERIC_MESSAGE,
      resetToken,
      phone: user.phone
    });
  } catch (error) {
    console.error('Find user for password reset error:', error);
    return respondAuthError(res, 500, 'PASSWORD_RESET_FIND_FAILED', 'Error starting password reset', {
      error: error.message
    });
  }
};

// ========== 5️ FORGOT PASSWORD - RESET DIRECT (Option D, ecomm) ==========

const resetPasswordDirect = async (req, res) => {
  try {
    const resetToken = String(req.body.resetToken || '').trim();
    const newPassword = String(req.body.newPassword || '');
    const confirmPassword = String(req.body.confirmPassword || '');

    if (!resetToken || !newPassword || !confirmPassword) {
      return respondAuthError(
        res,
        400,
        'PASSWORD_RESET_PAYLOAD_INVALID',
        'Reset token, new password and confirm password are required'
      );
    }

    if (newPassword !== confirmPassword) {
      return respondAuthError(res, 400, 'PASSWORD_MISMATCH', 'Passwords do not match');
    }

    if (newPassword.length < 6) {
      return respondAuthError(res, 400, 'PASSWORD_TOO_SHORT', 'Password must be at least 6 characters');
    }

    let decoded;
    try {
      decoded = await consumePasswordResetToken(resetToken);
    } catch (tokenErr) {
      const code = tokenErr?.code || 'RESET_TOKEN_INVALID';
      const status =
        code === 'RESET_TOKEN_EXPIRED'
          ? 401
          : code === 'RESET_TOKEN_STORE_UNAVAILABLE'
            ? 503
            : 401;
      return respondAuthError(res, status, code, tokenErr.message || 'Invalid reset token');
    }

    const user = await User.findById(decoded.id).select('+password name email phone status');
    if (!user) {
      return respondAuthError(res, 404, 'USER_NOT_FOUND', 'User not found');
    }

    // Update password (model pre-save hook hashes it — do not hash manually)
    user.password = newPassword;
    // Clear any legacy OTP reset fields if present from older flow
    user.passwordResetOTP = undefined;
    user.passwordResetOTPExpires = undefined;
    await user.save();

    await clearPasswordResetFindAttempts(user.phone);

    // Silent security net — never block the API response on email failure
    if (user.email) {
      setImmediate(() => {
        sendPasswordChangedNotificationEmail(user).catch(() => {});
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Password reset successful. You can now login with your new password.',
      phone: user.phone || null
    });
  } catch (error) {
    console.error('Reset password direct error:', error);
    return respondAuthError(res, 500, 'PASSWORD_RESET_FAILED', 'Error resetting password', {
      error: error.message
    });
  }
};


// Legacy OTP forgot-password handlers remain LIVE below for wholesaleFrontend
// compatibility. Ecomm uses findUserForPasswordReset + resetPasswordDirect.


// Live wrappers kept so wholesaleFrontend OTP forgot-password continues to work
// until that app is migrated. Ecomm no longer uses these.
const sendPasswordResetOTP = async (req, res) => {
  try {
    const { identifier } = req.body;

    if (!identifier) {
      return respondAuthError(res, 400, 'IDENTIFIER_REQUIRED', 'Email or phone number is required');
    }

    const user = await User.findOne({
      $or: [
        { email: identifier },
        { phone: identifier }
      ]
    });

    if (!user) {
      return res.status(200).json({
        success: true,
        message: "If account exists, OTP will be sent"
      });
    }

    const otp = generateOTP();
    const otpExpires = new Date(Date.now() + getOtpExpiryMs());

    user.passwordResetOTP = otp;
    user.passwordResetOTPExpires = otpExpires;
    await user.save({ validateBeforeSave: false });

    const isEmail = String(identifier).includes('@');

    try {
      await deliverOtpFor({
        phone: user.phone,
        email: user.email,
        otp,
        purpose: 'password_reset',
        forceChannel: isEmail ? 'email' : 'sms'
      });
    } catch (deliverErr) {
      console.error('Password reset OTP delivery failed:', deliverErr?.message, deliverErr?.details || '');
      return respondAuthError(
        res,
        502,
        'OTP_DELIVERY_FAILED',
        'Could not send OTP. Please try again in a moment.'
      );
    }

    return res.status(200).json({
      success: true,
      message: `OTP sent to your ${isEmail ? 'email' : 'phone'}`,
      identifierType: isEmail ? 'email' : 'phone'
    });

  } catch (error) {
    console.error("Send password reset OTP error:", error);
    return respondAuthError(res, 500, 'PASSWORD_RESET_OTP_SEND_FAILED', 'Error sending OTP', { error: error.message });
  }
};

const verifyPasswordResetOTP = async (req, res) => {
  try {
    const { identifier, otp } = req.body;

    if (!identifier || !otp) {
      return respondAuthError(res, 400, 'IDENTIFIER_OTP_REQUIRED', 'Identifier and OTP are required');
    }

    const user = await User.findOne({
      $or: [
        { email: identifier },
        { phone: identifier }
      ]
    }).select("+passwordResetOTP +passwordResetOTPExpires");

    if (!user) {
      return respondAuthError(res, 404, 'USER_NOT_FOUND', 'User not found');
    }

    if (!user.passwordResetOTP || !user.passwordResetOTPExpires) {
      return respondAuthError(res, 400, 'PASSWORD_RESET_OTP_NOT_REQUESTED', 'No OTP request found');
    }

    if (new Date() > user.passwordResetOTPExpires) {
      return respondAuthError(res, 400, 'OTP_EXPIRED', 'OTP has expired. Please request a new one.');
    }

    if (user.passwordResetOTP !== otp) {
      return respondAuthError(res, 400, 'OTP_INVALID', 'Invalid OTP');
    }

    return res.status(200).json({
      success: true,
      message: "OTP verified successfully"
    });

  } catch (error) {
    console.error("Verify password reset OTP error:", error);
    return respondAuthError(res, 500, 'PASSWORD_RESET_OTP_VERIFY_FAILED', 'Error verifying OTP', { error: error.message });
  }
};

const resetPasswordWithOTP = async (req, res) => {
  try {
    const { identifier, otp, newPassword } = req.body;

    if (!identifier || !otp || !newPassword) {
      return respondAuthError(res, 400, 'PASSWORD_RESET_PAYLOAD_INVALID', 'Identifier, OTP and new password are required');
    }

    if (newPassword.length < 6) {
      return respondAuthError(res, 400, 'PASSWORD_TOO_SHORT', 'Password must be at least 6 characters');
    }

    const user = await User.findOne({
      $or: [
        { email: identifier },
        { phone: identifier }
      ]
    }).select("+passwordResetOTP +passwordResetOTPExpires");

    if (!user) {
      return respondAuthError(res, 404, 'USER_NOT_FOUND', 'User not found');
    }

    if (!user.passwordResetOTP || !user.passwordResetOTPExpires) {
      return respondAuthError(res, 400, 'PASSWORD_RESET_OTP_NOT_REQUESTED', 'No OTP request found');
    }

    if (new Date() > user.passwordResetOTPExpires) {
      return respondAuthError(res, 400, 'OTP_EXPIRED', 'OTP has expired. Please request a new one.');
    }

    if (user.passwordResetOTP !== otp) {
      return respondAuthError(res, 400, 'OTP_INVALID', 'Invalid OTP');
    }

    user.password = newPassword;
    user.passwordResetOTP = undefined;
    user.passwordResetOTPExpires = undefined;
    await user.save();

    return res.status(200).json({
      success: true,
      message: "Password reset successful. You can now login with your new password."
    });

  } catch (error) {
    console.error("Reset password error:", error);
    return respondAuthError(res, 500, 'PASSWORD_RESET_FAILED', 'Error resetting password', { error: error.message });
  }
};

// ========== 7️ LOGOUT ==========
const logout = async (req, res) => {
  try {
    const token = getTokenFromHeader(req);

    if (token) {
      const decoded = jwt.decode(token);
      const nowSeconds = Math.floor(Date.now() / 1000);
      const ttl = decoded && decoded.exp ? Math.max(0, decoded.exp - nowSeconds) : 0;

      const redis = redisManager.getRedisClient();
      if (redis) {
        try {
          await redis.set(`bl_${token}`, '1');
          if (ttl > 0) await redis.expire(`bl_${token}`, ttl);
        } catch (err) {
          tokenStore.add(token, ttl);
        }
      } else {
        tokenStore.add(token, ttl);
      }
    }

    const logoutPortal = normalizeRefreshPortal(req.body?.portal || req.headers['x-auth-portal'] || req.user?.portal || req.user?.userType);
    const { refreshToken } = readRefreshTokenFromRequest(req, logoutPortal || 'ecomm');
    if (refreshToken) {
      const hashedToken = hashToken(refreshToken);
      const decoded = jwt.decode(refreshToken);
      if (decoded?.id) {
        await refreshTokenSession.revokeSessionByTokenHash(decoded.id, hashedToken);
      }
    }

    clearRefreshTokenCookie(req, res, logoutPortal || 'ecomm');

    return res.status(200).json({
      success: true,
      message: "Logged out successfully"
    });

  } catch (error) {
    console.error("Logout error:", error);
    return respondAuthError(res, 500, 'LOGOUT_FAILED', 'Error during logout');
  }
};


// ========== 8️ REFRESH ACCESS TOKEN ==========
const refreshAccessToken = async (req, res) => {
  try {
    const refreshPortal = normalizeRefreshPortal(req.body?.portal || req.headers['x-auth-portal']);
    const candidates = listRefreshCookieCandidates(req, refreshPortal || 'ecomm');

    if (candidates.length === 0) {
      return respondAuthError(res, 401, 'REFRESH_TOKEN_MISSING', 'Refresh token missing');
    }

    let session = null;
    let cookieName = null;
    let presentedRefreshToken = null;

    for (const candidate of candidates) {
      const resolved = await resolveRefreshSession(candidate.refreshToken);
      if (resolved) {
        session = resolved;
        cookieName = candidate.cookieName;
        presentedRefreshToken = candidate.refreshToken;
        break;
      }
    }

    if (!session) {
      return respondAuthError(res, 401, 'SESSION_EXPIRED', 'Session expired. Please login again.');
    }

    const { user, presentedHash, slot, matchKind } = session;

    const refreshedPortal =
      refreshPortal ||
      (cookieName === 'refreshToken_admin_wholesale'
        ? 'admin-wholesale'
        : cookieName === 'refreshToken_admin_ecomm'
          ? 'admin-ecomm'
          : cookieName === 'refreshToken_wholesale'
            ? 'wholesale'
            : 'ecomm');

    const portalDecision = canLoginForPortal(user, refreshedPortal);
    if (!portalDecision.allowed) {
      return respondAuthError(
        res,
        403,
        portalDecision.code || 'PORTAL_ACCESS_DENIED',
        portalDecision.message || 'Not allowed to refresh session for this portal.'
      );
    }

    // Concurrent refresh with already-rotated cookie: issue access token only (no second rotation).
    if (matchKind === 'replay') {
      const newAccessToken = generateAccessToken(user._id, user.userType, user.role, refreshedPortal);
      return res.status(200).json({
        success: true,
        accessToken: newAccessToken
      });
    }

    const newAccessToken = generateAccessToken(user._id, user.userType, user.role, refreshedPortal);
    const newRefreshToken = generateRefreshToken(user._id);
    const newHashedToken = hashToken(newRefreshToken);
    const deviceInfo = slot.deviceInfo || 'Unknown';

    const rotation = await refreshTokenSession.rotateSession(
      user._id,
      presentedHash,
      newHashedToken,
      deviceInfo
    );

    if (!rotation.rotated) {
      const replaySession = await refreshTokenSession.lookupSession(presentedRefreshToken);
      if (replaySession && replaySession.matchKind === 'replay') {
        return res.status(200).json({
          success: true,
          accessToken: newAccessToken
        });
      }
      return respondAuthError(res, 401, 'SESSION_EXPIRED', 'Session expired. Please login again.');
    }

    setRefreshTokenCookie(req, res, refreshedPortal, newRefreshToken);

    // console.log(" New tokens sent successfully");

    return res.status(200).json({
      success: true,
      accessToken: newAccessToken
    });

  } catch (error) {
    console.error("Refresh token error:", error);
    return respondAuthError(res, 500, 'REFRESH_TOKEN_ROTATION_FAILED', 'Could not refresh token', { error: error.message });
  }
};
// ========== 9️ GET CURRENT USER ==========

const me = async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return respondAuthError(res, 404, 'USER_NOT_FOUND', 'User not found');
    }

    const tokenPortal = normalizePortal(req.authPortal || req.headers['x-auth-portal']);
    if (
      (tokenPortal === 'admin-ecomm' || tokenPortal === 'admin-wholesale') &&
      !isPrivilegedAccount(user)
    ) {
      return respondAuthError(
        res,
        403,
        'PORTAL_ACCESS_DENIED',
        'This account is not allowed to access the admin portal.'
      );
    }

    return res.status(200).json({
      success: true,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        phone: user.phone,
        userType: user.userType,
         role: user.role || user.userType,  // ✅ ADD THIS
        status: user.status,
        isPhoneVerified: user.isPhoneVerified,
         isEmailVerified: user.isEmailVerified,  // ✅ Add this too
        isProfileComplete: user.isProfileComplete  // ✅ Add this too
      }
    });
  } catch (error) {
    console.error('Me error:', error);
    return respondAuthError(res, 500, 'PROFILE_FETCH_FAILED', 'Error fetching profile', { error: error.message });
  }
};

// ========== 10 UPDATE PROFILE ==========

const updateProfile = async (req, res) => {
  try {
    const updates = {};
    const hasEmailChange = Object.prototype.hasOwnProperty.call(req.body || {}, 'email');
    const hasPhoneChange = Object.prototype.hasOwnProperty.call(req.body || {}, 'phone');

    // Identity fields require explicit OTP/verification flow; do not mutate directly here.
    if (hasEmailChange || hasPhoneChange) {
      return res.status(409).json({
        success: false,
        code: 'PROFILE_CONTACT_CHANGE_REQUIRES_VERIFICATION',
        message: 'Email/phone update requires verification flow. Use dedicated contact-change endpoint.'
      });
    }

    if (typeof req.body?.name === 'string' && req.body.name.trim()) {
      updates.name = req.body.name.trim();
    }

    if (!Object.keys(updates).length) {
      return respondAuthError(res, 400, 'PROFILE_FIELDS_MISSING', 'No updatable profile fields provided');
    }

    const user = await User.findByIdAndUpdate(req.userId, { $set: updates }, { new: true });
    if (!user) {
      return respondAuthError(res, 404, 'USER_NOT_FOUND', 'User not found');
    }

    return res.status(200).json({
      success: true,
      message: 'Profile updated',
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone
      }
    });
  } catch (error) {
    if (error?.code === 11000) {
      const key = Object.keys(error.keyPattern || {})[0] || 'field';
      return res.status(409).json({
        success: false,
        code: 'DUPLICATE_PROFILE_FIELD',
        message: `${key} is already in use`
      });
    }
    console.error('Update profile error:', error);
    return respondAuthError(res, 500, 'PROFILE_UPDATE_FAILED', 'Error updating profile', { error: error.message });
  }
};

// ========== 10B REQUEST CONTACT CHANGE OTP ==========
const requestContactChangeOTP = async (req, res) => {
  return respondAuthError(
    res,
    403,
    'CONTACT_CHANGE_DISABLED',
    'Email/phone change is currently disabled. Please contact support.'
  );
};

// ========== 10C VERIFY CONTACT CHANGE OTP ==========
const verifyContactChangeOTP = async (req, res) => {
  return respondAuthError(
    res,
    403,
    'CONTACT_CHANGE_DISABLED',
    'Email/phone change is currently disabled. Please contact support.'
  );
};

// ========== 11 CHANGE PASSWORD ==========

const changePassword = async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;

    if (!oldPassword || !newPassword) {
      return respondAuthError(res, 400, 'PASSWORD_CHANGE_PAYLOAD_INVALID', 'Old and new passwords are required');
    }

    if (newPassword.length < 6) {
      return respondAuthError(res, 400, 'PASSWORD_TOO_SHORT', 'New password must be at least 6 characters');
    }

    const user = await User.findById(req.userId).select('+password');
    if (!user) {
      return respondAuthError(res, 404, 'USER_NOT_FOUND', 'User not found');
    }

    const isValid = await user.comparePassword(oldPassword);
    if (!isValid) {
      return respondAuthError(res, 401, 'OLD_PASSWORD_INVALID', 'Old password is incorrect');
    }

    user.password = newPassword;
    await user.save();

    return res.status(200).json({
      success: true,
      message: 'Password changed successfully'
    });

  } catch (error) {
    console.error('Change password error:', error);
    return respondAuthError(res, 500, 'PASSWORD_CHANGE_FAILED', 'Error changing password', { error: error.message });
  }
};

// ========== 1️2 GOOGLE AUTH ==========

const googleAuth = async (req, res) => {
  try {
    const { idToken } = req.body;

    if (!idToken || typeof idToken !== "string") {
      return respondAuthError(res, 400, 'GOOGLE_ID_TOKEN_REQUIRED', 'Valid idToken is required');
    }

    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID
    });

    const payload = ticket.getPayload();

    if (!payload.email || !payload.email_verified) {
      return respondAuthError(res, 400, 'GOOGLE_EMAIL_NOT_VERIFIED', 'Google email not verified');
    }

    const { sub: googleId, email, name = "" } = payload;

    let user = await User.findOne({ email });

    if (user) {
      if (!user.googleId) user.googleId = googleId;
      user.isEmailVerified = true;
      user.status = "active";
    } else {
      user = new User({
        googleId,
        email,
        name,
        isEmailVerified: true,
        status: "active",
        userType: "user",
        registrationMethod: "google"
      });
    }

  const accessToken = generateAccessToken(user._id, user.userType, user.role);
const refreshToken = generateRefreshToken(user._id);
const hashedRefreshToken = hashToken(refreshToken);

// Get device info
const deviceInfo = req.headers['user-agent'] || req.body.deviceInfo || 'Google-Login';

await user.save();

await refreshTokenSession.appendSession(user._id, {
  hashedToken: hashedRefreshToken,
  deviceInfo
});

setRefreshTokenCookie(req, res, 'ecomm', refreshToken);


    return res.status(200).json({
      success: true,
      message: "Google login successful",
      accessToken,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        userType: user.userType
      }
    });

  } catch (error) {
    console.error("[Google Auth Error]", error);
    return respondAuthError(res, 500, 'GOOGLE_AUTH_FAILED', 'Google authentication failed');
  }
};


// ========== DEVICE MANAGEMENT CONTROLLER FUNCTIONS ==========

// Get all active devices
const getActiveDevices = async (req, res) => {
  try {
    const devices = await refreshTokenSession.listActiveSessions(req.userId);
    if (!devices.length) {
      const user = await User.findById(req.userId).select('_id');
      if (!user) {
        return res.status(404).json({ success: false, code: 'USER_NOT_FOUND', message: 'User not found' });
      }
    }
    return res.json({ success: true, devices });
  } catch (error) {
    return res.status(500).json({
      success: false,
      code: 'FETCH_DEVICES_FAILED',
      message: 'Could not fetch active devices'
    });
  }
};

// Logout from specific device
const logoutDevice = async (req, res) => {
  try {
    const { deviceId } = req.body;
    if (!deviceId) {
      return res.status(400).json({ success: false, code: 'DEVICE_ID_REQUIRED', message: 'deviceId is required' });
    }
    const user = await User.findById(req.userId).select('_id');
    if (!user) {
      return res.status(404).json({ success: false, code: 'USER_NOT_FOUND', message: 'User not found' });
    }
    await refreshTokenSession.revokeSessionByDeviceId(req.userId, deviceId);
    return res.json({ success: true, message: 'Device logged out successfully' });
  } catch (error) {
    return res.status(500).json({
      success: false,
      code: 'LOGOUT_DEVICE_FAILED',
      message: 'Could not logout device'
    });
  }
};

// Logout from all devices
const logoutAllDevices = async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('_id');
    if (!user) {
      return res.status(404).json({ success: false, code: 'USER_NOT_FOUND', message: 'User not found' });
    }
    await refreshTokenSession.revokeAllSessions(req.userId);
    clearRefreshTokenCookie(req, res, 'ecomm');
    return res.json({ success: true, message: 'Logged out from all devices' });
  } catch (error) {
    return res.status(500).json({
      success: false,
      code: 'LOGOUT_ALL_DEVICES_FAILED',
      message: 'Could not logout from all devices'
    });
  }
};


// ========== EXPORTS ==========

module.exports = {
  register,
  verifyOTPAndLogin,
  login,
  findUserForPasswordReset,
  resetPasswordDirect,
  // Legacy OTP forgot-password (kept live for wholesaleFrontend)
  sendPasswordResetOTP,
  verifyPasswordResetOTP,
  resetPasswordWithOTP,
  logout,
  refreshAccessToken,
  me,
  updateProfile,
  changePassword,
  requestContactChangeOTP,
  verifyContactChangeOTP,
  googleAuth , 
  getActiveDevices,
  logoutDevice,
  logoutAllDevices,
  getRefreshCookieOptions
};