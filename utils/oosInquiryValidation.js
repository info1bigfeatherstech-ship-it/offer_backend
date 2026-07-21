/**
 * Email / phone validation for out-of-stock inquiries (server).
 * Mirrors frontend/offer/src/utils/oosInquiryValidation.js
 * Both email and phone are required.
 *
 * Waitlist eligibility:
 * - ecomm: true OOS only (qty <= 0)
 * - wholesale: OUT_OF_STOCK or MOQ_UNMET (same as storefrontCatalog availability)
 */

const { getVariantAvailability } = require('./storefrontCatalog');

const EMAIL_RE =
  /^[a-zA-Z0-9](?:[a-zA-Z0-9._%+-]{0,62}[a-zA-Z0-9])?@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z]{2,})+$/;

const INQUIRY_REASONS = ['out_of_stock', 'moq_unmet'];

function normalizeInquiryPhone(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return digits;
}

function isValidInquiryEmail(raw) {
  const email = String(raw || '').trim().toLowerCase();
  if (!email || email.length > 254) return false;
  if (email.includes('..') || email.startsWith('.') || email.endsWith('.')) return false;
  if (!email.includes('@') || !email.includes('.')) return false;
  return EMAIL_RE.test(email);
}

function isValidInquiryPhone(raw) {
  const digits = normalizeInquiryPhone(raw);
  return /^[6-9]\d{9}$/.test(digits);
}

/**
 * @param {{ email?: string, phone?: string }} input
 * @returns {{ email: string, phone: string }}
 */
function validateInquiryContact(input = {}) {
  const emailRaw = String(input.email || '').trim();
  const phoneRaw = String(input.phone || '').trim();

  if (!emailRaw) {
    const err = new Error('Email is required so we can notify you when it is back.');
    err.statusCode = 400;
    err.code = 'EMAIL_REQUIRED';
    err.field = 'email';
    throw err;
  }
  if (!isValidInquiryEmail(emailRaw)) {
    const err = new Error('Enter a valid email (e.g. name@gmail.com).');
    err.statusCode = 400;
    err.code = 'INVALID_EMAIL';
    err.field = 'email';
    throw err;
  }

  if (!phoneRaw) {
    const err = new Error('Mobile number is required.');
    err.statusCode = 400;
    err.code = 'PHONE_REQUIRED';
    err.field = 'phone';
    throw err;
  }
  if (!isValidInquiryPhone(phoneRaw)) {
    const err = new Error('Enter a valid 10-digit Indian mobile number.');
    err.statusCode = 400;
    err.code = 'INVALID_PHONE';
    err.field = 'phone';
    throw err;
  }

  return {
    email: emailRaw.toLowerCase(),
    phone: normalizeInquiryPhone(phoneRaw),
  };
}

/**
 * @param {object|null|undefined} variant
 */
function isVariantOutOfStock(variant) {
  if (!variant) return true;
  const inv = variant.inventory || {};
  if (inv.trackInventory === false) return false;
  return Number(inv.quantity || 0) <= 0;
}

/**
 * Whether a customer may join the OOS / MOQ waitlist for this storefront.
 * Ecomm behaviour unchanged: only true out-of-stock (qty <= 0).
 *
 * @param {object|null|undefined} variant
 * @param {'ecomm'|'wholesale'|string} storefront
 * @returns {{ eligible: boolean, reason: 'out_of_stock'|'moq_unmet'|null }}
 */
function resolveInquiryWaitlistEligibility(variant, storefront) {
  const sf = String(storefront || '').toLowerCase().trim() === 'wholesale' ? 'wholesale' : 'ecomm';

  if (sf === 'ecomm') {
    if (!isVariantOutOfStock(variant)) {
      return { eligible: false, reason: null };
    }
    return { eligible: true, reason: 'out_of_stock' };
  }

  const avail = getVariantAvailability(variant, 'wholesale');
  if (avail.status === 'OUT_OF_STOCK') {
    return { eligible: true, reason: 'out_of_stock' };
  }
  if (avail.status === 'MOQ_UNMET') {
    return { eligible: true, reason: 'moq_unmet' };
  }
  return { eligible: false, reason: null };
}

module.exports = {
  INQUIRY_REASONS,
  normalizeInquiryPhone,
  isValidInquiryEmail,
  isValidInquiryPhone,
  validateInquiryContact,
  isVariantOutOfStock,
  resolveInquiryWaitlistEligibility,
};
