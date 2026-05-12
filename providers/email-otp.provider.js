/**
 * Email OTP Provider
 * -------------------
 * Sends OTPs via Gmail SMTP (nodemailer). Mirrors the contract of the SMS
 * providers (`fast2sms.provider`, `twilio.provider`, `factor2.provider`) so it
 * can be plugged into the same delivery pipeline.
 *
 * Contract:
 *   sendEmailOTP({ to, otp, purpose }) -> Promise<{ success, providerMessageId }>
 *
 * The transporter is created lazily on first use so missing EMAIL_* env vars
 * fail loudly only when an email send is actually attempted (not at module
 * load time — that would crash the whole server in sms-only deployments).
 */

const nodemailer = require('nodemailer');

// Fallback used only when the caller does not supply explicit expiry minutes.
// (Kept in sync with otp-delivery.config DEFAULT_OTP_EXPIRY_MINUTES.)
const FALLBACK_EXPIRY_MINUTES = 5;

let cachedTransporter = null;

const getTransporter = () => {
  if (cachedTransporter) return cachedTransporter;

  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASSWORD;

  if (!user || !pass) {
    throw new Error(
      'EMAIL OTP transport not configured: set EMAIL_USER and EMAIL_PASSWORD env vars.'
    );
  }

  cachedTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass }
  });

  return cachedTransporter;
};

// Templates keyed by purpose. Adding a new purpose? Just add an entry here.
const TEMPLATES = {
  registration: {
    subject: 'Verify your account — OfferWaleBaba',
    title: 'Welcome to OfferWaleBaba',
    intro: 'Use the OTP below to verify your account and complete registration.'
  },
  password_reset: {
    subject: 'Password Reset OTP — OfferWaleBaba',
    title: 'Password Reset Request',
    intro: 'Use the OTP below to reset your password.'
  },
  contact_change: {
    subject: 'Confirm contact change — OfferWaleBaba',
    title: 'Contact Update Confirmation',
    intro: 'Use the OTP below to confirm your contact details change.'
  },
  wholesaler_activation: {
    subject: 'Wholesaler Account Activation OTP — OfferWaleBaba',
    title: 'Wholesaler Activation',
    intro: 'Use the OTP below to activate your wholesaler account.'
  },
  generic: {
    subject: 'Your OTP — OfferWaleBaba',
    title: 'One-Time Password',
    intro: 'Use the OTP below to continue.'
  }
};

const renderHtml = (otp, tpl, minutes) => `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;padding:24px;border:1px solid #eee;border-radius:8px;">
    <h2 style="margin:0 0 8px 0;color:#222;">${tpl.title}</h2>
    <p style="color:#555;line-height:1.5;">${tpl.intro}</p>
    <div style="font-size:28px;font-weight:700;letter-spacing:6px;background:#f7f7f7;padding:14px 18px;text-align:center;border-radius:6px;margin:18px 0;color:#111;">
      ${otp}
    </div>
    <p style="color:#888;font-size:13px;">This OTP is valid for ${minutes} minute${minutes === 1 ? '' : 's'}. If you didn't request it, please ignore this email.</p>
    <p style="color:#aaa;font-size:12px;margin-top:24px;">— OfferWaleBaba</p>
  </div>
`;

const renderText = (otp, tpl, minutes) =>
  `${tpl.title}\n\n${tpl.intro}\n\nOTP: ${otp}\n\nThis OTP is valid for ${minutes} minute${minutes === 1 ? '' : 's'}.\n\n— OfferWaleBaba`;

/**
 * Send an OTP via email.
 * @param {Object} params
 * @param {string} params.to        Recipient email address
 * @param {string} params.otp       6-digit OTP code
 * @param {string} [params.purpose] One of: registration | password_reset | contact_change | wholesaler_activation | generic
 * @param {number} [params.minutes] OTP expiry in minutes (shown in email body).
 *                                  Caller (delivery layer) supplies this so
 *                                  this module has zero dependency on the
 *                                  delivery config — avoids circular imports.
 * @returns {Promise<{success:boolean,providerMessageId:string}>}
 */
const sendEmailOTP = async ({ to, otp, purpose = 'generic', minutes } = {}) => {
  const email = String(to || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    const err = new Error('Invalid email address for OTP delivery');
    err.code = 'EMAIL_OTP_INVALID_RECIPIENT';
    throw err;
  }

  if (!otp || !/^\d{4,8}$/.test(String(otp))) {
    const err = new Error('Invalid OTP payload for email delivery');
    err.code = 'EMAIL_OTP_INVALID_PAYLOAD';
    throw err;
  }

  const tpl = TEMPLATES[purpose] || TEMPLATES.generic;
  const expiryMinutes =
    Number.isFinite(minutes) && minutes > 0 ? Math.floor(minutes) : FALLBACK_EXPIRY_MINUTES;
  const transporter = getTransporter();

  const info = await transporter.sendMail({
    from: `"OfferWaleBaba" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: tpl.subject,
    text: renderText(otp, tpl, expiryMinutes),
    html: renderHtml(otp, tpl, expiryMinutes)
  });

  return {
    success: true,
    providerMessageId: info?.messageId || null
  };
};

/**
 * Mirror of SMS-provider shape: providers expose `sendSMS(phone, message)`.
 * Email exposes `sendEmail(to, otp, purpose)` plus a SMS-shape adapter so the
 * delivery layer can treat both transports uniformly.
 */
module.exports = {
  sendEmailOTP,
  // Adapter for symmetry with sms-provider contract (rarely used directly)
  sendEmail: (to, otp, purpose) => sendEmailOTP({ to, otp, purpose })
};
