/**
 * Physical delivery-address validation (user + courier APIs).
 * Used by address controller on create / update when payload touches non-meta fields.
 *
 * Shiprocket enforces billing_address + billing_address_2 combined length ≥ 3; we stay well
 * above that so short placeholders ("3", ".") cannot reach the DB when users add/edit
 * addresses through the API.
 */

const MIN_ADDRESS_LINE1_LEN = 10;
const MAX_ADDRESS_LINE_LEN = 200;
/** Courier-documented floor — line1 min length already exceeds this when non-empty line2 allowed. */
const MIN_COMBINED_STREET_CHARS = 3;

function trimStr(value) {
  if (value == null) return '';
  return String(value).trim();
}

/**
 * @param {string} line1Raw
 * @param {string} line2Raw
 * @returns {{ ok: true, line1: string, line2: string } | { ok: false, code: string, message: string }}
 */
function validateStreetLines(line1Raw, line2Raw) {
  const line1 = trimStr(line1Raw);
  const line2 = trimStr(line2Raw);
  const combinedNoSpace = (line1 + line2).replace(/\s/g, '');

  if (!line1) {
    return {
      ok: false,
      code: 'ADDRESS_LINE1_REQUIRED',
      message: 'Address line 1 is required. Include street name, building, or road details.'
    };
  }
  if (line1.length < MIN_ADDRESS_LINE1_LEN) {
    return {
      ok: false,
      code: 'ADDRESS_LINE1_TOO_SHORT',
      message: `Address line 1 must be at least ${MIN_ADDRESS_LINE1_LEN} characters (not just flat number or landmark).`
    };
  }
  if (line1.length > MAX_ADDRESS_LINE_LEN) {
    return {
      ok: false,
      code: 'ADDRESS_LINE1_TOO_LONG',
      message: `Address line 1 must be at most ${MAX_ADDRESS_LINE_LEN} characters.`
    };
  }
  if (line2.length > MAX_ADDRESS_LINE_LEN) {
    return {
      ok: false,
      code: 'ADDRESS_LINE2_TOO_LONG',
      message: `Address line 2 must be at most ${MAX_ADDRESS_LINE_LEN} characters.`
    };
  }
  if (combinedNoSpace.length < MIN_COMBINED_STREET_CHARS) {
    return {
      ok: false,
      code: 'ADDRESS_STREET_TOO_SHORT',
      message: 'Street address is too short for courier systems.'
    };
  }
  return { ok: true, line1, line2 };
}

/**
 * Full payload validation for create or merged document on update.
 *
 * @param {object} body — raw fields
 * @returns {{ ok: true, data: object } | { ok: false, code: string, message: string, errors: Array<{field: string, code: string, message: string}> }}
 */
function validatePhysicalAddressForSave(body) {
  const errors = [];

  const fullName = trimStr(body.fullName);
  const phoneRaw = trimStr(body.phone);
  const phoneDigits = phoneRaw.replace(/\D/g, '');
  const houseNumber = trimStr(body.houseNumber);
  const area = trimStr(body.area);
  const landmark = trimStr(body.landmark);
  const city = trimStr(body.city);
  const state = trimStr(body.state);
  const postalCode = trimStr(body.postalCode);
  const country = trimStr(body.country) || 'India';

  if (!fullName) {
    errors.push({ field: 'fullName', code: 'REQUIRED', message: 'Full name is required.' });
  }
  if (!phoneRaw) {
    errors.push({ field: 'phone', code: 'REQUIRED', message: 'Phone number is required.' });
  } else if (phoneDigits.length !== 10) {
    errors.push({ field: 'phone', code: 'INVALID_PHONE', message: 'Phone must be a 10-digit Indian mobile number.' });
  }
  if (!houseNumber) {
    errors.push({ field: 'houseNumber', code: 'REQUIRED', message: 'House / flat / building number is required.' });
  } else if (houseNumber.length > 80) {
    errors.push({ field: 'houseNumber', code: 'TOO_LONG', message: 'House / flat number is too long.' });
  }
  if (!area) {
    errors.push({ field: 'area', code: 'REQUIRED', message: 'Area / locality is required.' });
  } else if (area.length < 2) {
    errors.push({ field: 'area', code: 'TOO_SHORT', message: 'Area / locality must be at least 2 characters.' });
  } else if (area.length > 120) {
    errors.push({ field: 'area', code: 'TOO_LONG', message: 'Area / locality is too long.' });
  }
  if (!city) {
    errors.push({ field: 'city', code: 'REQUIRED', message: 'City is required.' });
  }
  if (!state) {
    errors.push({ field: 'state', code: 'REQUIRED', message: 'State is required.' });
  }
  if (!postalCode) {
    errors.push({ field: 'postalCode', code: 'REQUIRED', message: 'Postal code is required.' });
  } else if (!/^\d{6}$/.test(postalCode)) {
    errors.push({ field: 'postalCode', code: 'INVALID_PINCODE', message: 'Postal code must be exactly 6 digits.' });
  }

  const street = validateStreetLines(body.addressLine1, body.addressLine2);
  if (!street.ok) {
    errors.push({ field: 'addressLine1', code: street.code, message: street.message });
  }

  if (errors.length) {
    return {
      ok: false,
      code: 'ADDRESS_VALIDATION_FAILED',
      message: errors[0].message,
      errors
    };
  }

  return {
    ok: true,
    data: {
      fullName,
      phone: phoneDigits,
      houseNumber,
      area,
      landmark,
      addressLine1: street.line1,
      addressLine2: street.line2,
      city,
      state,
      postalCode,
      country
    }
  };
}

/** Updates that only toggle meta — full street validation not required (legacy rows may still set default). */
const ADDRESS_META_ONLY_KEYS = new Set([
  'isDefault',
  'isGift',
  'addressType',
  'deliveryInstructions'
]);

/**
 * @param {string[]} keys — Object.keys(req.body)
 * @returns {boolean} whether to run validatePhysicalAddressForSave on merged address
 */
function shouldRunFullAddressValidation(keys) {
  const filtered = keys.filter((k) => k !== 'id');
  if (filtered.length === 0) return false;
  return filtered.some((k) => !ADDRESS_META_ONLY_KEYS.has(k));
}

module.exports = {
  MIN_ADDRESS_LINE1_LEN,
  MAX_ADDRESS_LINE_LEN,
  MIN_COMBINED_STREET_CHARS,
  validateStreetLines,
  validatePhysicalAddressForSave,
  shouldRunFullAddressValidation,
  ADDRESS_META_ONLY_KEYS
};
