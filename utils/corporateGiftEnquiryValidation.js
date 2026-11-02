/**
 * Corporate customise-gift + bulk-order enquiry validation.
 * Reuses OOS phone + email format rules so contact checks stay consistent.
 */

const {
  normalizeInquiryPhone,
  isValidInquiryEmail,
  isValidInquiryPhone,
} = require('./oosInquiryValidation');

const { ENQUIRY_TYPES, STATUS_ENUM } = require('../models/CorporateGiftEnquiry');

const OPEN_STATUSES = ['pending', 'contacted', 'quoted'];

const MAX_GIFT_FILE_BYTES = 20 * 1024 * 1024;
const MAX_REFERENCE_PHOTOS = 6;
const MAX_LOGOS = 3;
const MAX_BUSINESS_CARDS = 1;
const MIN_MESSAGE_LEN = 10;
const MAX_MESSAGE_LEN = 2000;
const DUPLICATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/tiff',
  'image/heic',
  'image/heif',
  'image/avif',
];

const LOGO_MIME_TYPES = [...IMAGE_MIME_TYPES, 'application/pdf'];

function createHttpError(statusCode, code, message, field) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  if (field) err.field = field;
  return err;
}

function collapseWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function optionalText(value, { field, max, min = 0 } = {}) {
  const text = collapseWhitespace(value);
  if (!text) return null;
  if (min && text.length < min) {
    throw createHttpError(400, 'VALIDATION_FAILED', `${field} is too short`, field);
  }
  if (text.length > max) {
    throw createHttpError(400, 'VALIDATION_FAILED', `${field} is too long`, field);
  }
  return text;
}

function requiredText(value, { field, min = 2, max = 120 } = {}) {
  const text = collapseWhitespace(value);
  if (!text) {
    throw createHttpError(400, 'VALIDATION_FAILED', `${field} is required`, field);
  }
  if (text.length < min) {
    throw createHttpError(400, 'VALIDATION_FAILED', `${field} is too short`, field);
  }
  if (text.length > max) {
    throw createHttpError(400, 'VALIDATION_FAILED', `${field} is too long`, field);
  }
  return text;
}

function parseEnquiryType(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) {
    throw createHttpError(400, 'VALIDATION_FAILED', 'enquiryType is required', 'enquiryType');
  }
  if (!ENQUIRY_TYPES.includes(value)) {
    throw createHttpError(
      400,
      'VALIDATION_FAILED',
      'enquiryType must be custom or bulk',
      'enquiryType'
    );
  }
  return value;
}

function parseWholeNumber(raw, { field, code, required, emptyMessage }) {
  const asString = String(raw == null ? '' : raw).trim();
  if (!asString) {
    if (!required) return null;
    throw createHttpError(400, code, emptyMessage, field);
  }
  if (!/^\d+$/.test(asString)) {
    throw createHttpError(400, code, `${field} must be a whole number (e.g. 50 or 100)`, field);
  }
  const qty = Number.parseInt(asString, 10);
  if (!Number.isFinite(qty) || qty < 1 || qty > 100000) {
    throw createHttpError(400, code, `${field} must be between 1 and 100000`, field);
  }
  return qty;
}

function parseQuantity(raw, { required = true } = {}) {
  return parseWholeNumber(raw, {
    field: 'quantity',
    code: 'INVALID_QUANTITY',
    required,
    emptyMessage: 'Estimated quantity is required',
  });
}

function parseVolumeOrder(raw) {
  return parseWholeNumber(raw, {
    field: 'volumeOrder',
    code: 'INVALID_VOLUME_ORDER',
    required: false,
    emptyMessage: 'Volume order is required',
  });
}

function todayYmdIst() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function parseTargetDeliveryDate(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw createHttpError(
      400,
      'INVALID_DELIVERY_DATE',
      'Target delivery date must be YYYY-MM-DD',
      'targetDeliveryDate'
    );
  }
  const [year, month, day] = text.split('-').map((n) => Number(n));
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    throw createHttpError(
      400,
      'INVALID_DELIVERY_DATE',
      'Target delivery date is not a valid calendar day',
      'targetDeliveryDate'
    );
  }
  if (text < todayYmdIst()) {
    throw createHttpError(
      400,
      'INVALID_DELIVERY_DATE',
      'Target delivery date cannot be in the past',
      'targetDeliveryDate'
    );
  }
  return utc;
}

function parseOptionalEmail(raw) {
  const emailRaw = String(raw || '').trim();
  if (!emailRaw) return null;
  if (!isValidInquiryEmail(emailRaw)) {
    throw createHttpError(400, 'INVALID_EMAIL', 'Enter a valid email (e.g. name@gmail.com).', 'email');
  }
  return emailRaw.toLowerCase();
}

function parseRequiredPhone(raw) {
  const phoneRaw = String(raw || '').trim();
  if (!phoneRaw) {
    throw createHttpError(400, 'PHONE_REQUIRED', 'Mobile number is required', 'phone');
  }
  if (!isValidInquiryPhone(phoneRaw)) {
    throw createHttpError(
      400,
      'INVALID_PHONE',
      'Enter a valid 10-digit Indian mobile number.',
      'phone'
    );
  }
  return normalizeInquiryPhone(phoneRaw);
}

function validateCustomPayload(body, shared) {
  return {
    ...shared,
    city: requiredText(body.city, { field: 'city', min: 2, max: 120 }),
    occasion: requiredText(body.occasion, { field: 'occasion', min: 2, max: 120 }),
    giftCategory: requiredText(body.giftCategory, { field: 'giftCategory', min: 2, max: 120 }),
    quantity: parseQuantity(body.quantity, { required: true }),
    targetDeliveryDate: parseTargetDeliveryDate(body.targetDeliveryDate),
    message: optionalText(body.message, {
      field: 'message',
      min: MIN_MESSAGE_LEN,
      max: MAX_MESSAGE_LEN,
    }),
    businessType: null,
    volumeOrder: null,
  };
}

function validateBulkPayload(body, shared) {
  const message = optionalText(body.message, {
    field: 'message',
    min: MIN_MESSAGE_LEN,
    max: MAX_MESSAGE_LEN,
  });
  return {
    ...shared,
    city: optionalText(body.city, { field: 'city', min: 2, max: 120 }),
    occasion: null,
    giftCategory: null,
    quantity: null,
    targetDeliveryDate: null,
    message,
    businessType: requiredText(body.businessType, { field: 'businessType', min: 2, max: 120 }),
    volumeOrder: parseVolumeOrder(body.volumeOrder),
  };
}

function validateGiftEnquiryPayload(body = {}) {
  const enquiryType = parseEnquiryType(body.enquiryType);
  const shared = {
    enquiryType,
    name: requiredText(body.name, { field: 'name', min: 2, max: 120 }),
    email: parseOptionalEmail(body.email),
    phone: parseRequiredPhone(body.phone),
    organizationName: optionalText(body.organizationName, {
      field: 'organizationName',
      max: 160,
    }),
  };

  return enquiryType === 'bulk'
    ? validateBulkPayload(body, shared)
    : validateCustomPayload(body, shared);
}

function parseAdminStatus(raw) {
  const status = String(raw || '').trim().toLowerCase();
  if (!STATUS_ENUM.includes(status)) {
    throw createHttpError(
      400,
      'INVALID_STATUS',
      `status must be one of: ${STATUS_ENUM.join(', ')}`,
      'status'
    );
  }
  return status;
}

function parseAdminNote(raw) {
  if (raw == null) return undefined;
  const text = String(raw).trim();
  if (!text) return null;
  if (text.length > 500) {
    throw createHttpError(400, 'VALIDATION_FAILED', 'adminNote must be 500 characters or fewer', 'adminNote');
  }
  return text;
}

module.exports = {
  MAX_GIFT_FILE_BYTES,
  MAX_REFERENCE_PHOTOS,
  MAX_LOGOS,
  MAX_BUSINESS_CARDS,
  MIN_MESSAGE_LEN,
  MAX_MESSAGE_LEN,
  DUPLICATE_WINDOW_MS,
  IMAGE_MIME_TYPES,
  LOGO_MIME_TYPES,
  ENQUIRY_TYPES,
  STATUS_ENUM,
  OPEN_STATUSES,
  createHttpError,
  validateGiftEnquiryPayload,
  parseEnquiryType,
  parseQuantity,
  parseVolumeOrder,
  parseTargetDeliveryDate,
  parseAdminStatus,
  parseAdminNote,
  normalizeInquiryPhone,
  isValidInquiryEmail,
  isValidInquiryPhone,
};
