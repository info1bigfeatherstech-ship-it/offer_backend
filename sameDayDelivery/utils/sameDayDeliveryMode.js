'use strict';

const DELIVERY_MODES = Object.freeze(['standard', 'same_day']);

function parseDeliveryMode(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value || value === 'standard' || value === 'courier') return 'standard';
  if (value === 'same_day' || value === 'sdd' || value === 'sameday') return 'same_day';
  return null;
}

function isSameDayDeliveryMode(mode) {
  return parseDeliveryMode(mode) === 'same_day';
}

function isSameDayQuote(quote) {
  return isSameDayDeliveryMode(quote?.deliveryMode);
}

function isSameDayOrder(order) {
  return String(order?.fulfillmentMode || '').toLowerCase() === 'same_day';
}

function createSddHttpError(statusCode, code, message, field) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  if (field) err.field = field;
  return err;
}

function normalizePincode(raw) {
  return String(raw || '').replace(/\D/g, '').slice(0, 6);
}

function isValidPincode(raw) {
  return /^\d{6}$/.test(normalizePincode(raw));
}

module.exports = {
  DELIVERY_MODES,
  parseDeliveryMode,
  isSameDayDeliveryMode,
  isSameDayQuote,
  isSameDayOrder,
  createSddHttpError,
  normalizePincode,
  isValidPincode,
};
