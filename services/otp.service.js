/**
 * OTP Service
 * -----------
 * High-level OTP generation + delivery helpers used by controllers.
 *
 * - `generateOTP()`        — random 6-digit numeric code.
 * - `sendOTP(phone, otp)`  — LEGACY signature. Still routes through the new
 *                            delivery layer so existing call-sites continue to
 *                            work but now respect `OTP_DELIVERY_MODE`.
 * - `deliverOtpFor(...)`   — Preferred entry point. Accepts both phone and
 *                            email so the delivery layer can pick channel(s)
 *                            based on env.
 */

const crypto = require('crypto');
const {
  deliverOTP,
  validateRecipientsForMode,
  getDeliveryMode,
  OTP_DELIVERY_MODES,
  getOtpExpiryMinutes,
  getOtpExpiryMs
} = require('../config/otp-delivery.config');

const generateOTP = () => crypto.randomInt(100000, 999999).toString();

/**
 * LEGACY: Original signature `sendOTP(phone, otp)`.
 *
 * Kept for backward compatibility with any caller that only has a phone
 * number on hand (e.g. wholesaler activation when email isn't passed in).
 * It still routes through the env-driven delivery layer, so:
 *   - In `sms` mode → SMS to phone (original behaviour).
 *   - In `email` mode → ERRORS with a clear OTP_EMAIL_RECIPIENT_MISSING code,
 *     because no email was supplied. Callers should migrate to
 *     `deliverOtpFor({ phone, email, otp, ... })`.
 */
const sendOTP = async (phone, otp) => {
  await deliverOTP({ phone, otp, purpose: 'generic' });
  return otp;
};

/**
 * Preferred entry point — pass everything we know about the recipient and
 * the purpose. Returns the rich delivery report from the delivery layer so
 * controllers can echo it back to the frontend (e.g. show "OTP sent to
 * your email").
 *
 * @param {Object} params
 * @param {string} [params.phone]
 * @param {string} [params.email]
 * @param {string} params.otp
 * @param {string} [params.purpose]
 * @param {("sms"|"email"|"both")} [params.forceChannel]
 */
const deliverOtpFor = async ({ phone, email, otp, purpose, forceChannel } = {}) => {
  return deliverOTP({ phone, email, otp, purpose, forceChannel });
};

module.exports = {
  generateOTP,
  sendOTP,
  deliverOtpFor,
  validateRecipientsForMode,
  getDeliveryMode,
  OTP_DELIVERY_MODES,
  getOtpExpiryMinutes,
  getOtpExpiryMs
};
