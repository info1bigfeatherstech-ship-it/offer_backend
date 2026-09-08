/**
 * Physical delivery-address validation (user + courier APIs).
 * Used by address controller on create / update when payload touches non-meta fields.
 *
 * Shiprocket / Shipmozo compose street as:
 *   line1 = houseNumber, building, floor, addressLine1
 *   line2 = addressLine2, area, landmark
 * Shiprocket rejects when len(line1) + len(line2) > 190.
 * We enforce the same combined cap at save time (customer + admin) so Ship Now cannot fail later.
 *
 * Consignee / billing name has a separate courier-safe cap (fullName).
 */

const MIN_ADDRESS_LINE1_LEN = 10;
/** Per stored addressLine field (form fields); courier combined cap is stricter. */
const MAX_ADDRESS_LINE_LEN = 200;
/** Courier-documented floor — line1 min length already exceeds this when non-empty line2 allowed. */
const MIN_COMBINED_STREET_CHARS = 3;
/** Shiprocket billing_address + billing_address_2 combined character limit. */
const MAX_COURIER_COMBINED_STREET_CHARS = 190;
/**
 * Recipient name for courier APIs (Shipmozo consignee_name / Shiprocket billing_customer_name).
 * Long pasted address+phone dumps in fullName have caused live push-order failures.
 */
const MAX_FULL_NAME_LEN = 80;
const MAX_COURIER_CONSIGNEE_NAME_LEN = 80;

function trimStr(value) {
  if (value == null) return '';
  return String(value).trim();
}

/**
 * Courier-safe recipient name: collapse whitespace, hard truncate.
 * Does not invent a name when empty — returns fallback.
 *
 * @param {unknown} name
 * @param {string} [fallback='Customer']
 * @returns {string}
 */
function sanitizeCourierConsigneeName(name, fallback = 'Customer') {
  let s = trimStr(name).replace(/\s+/g, ' ');
  if (!s) return fallback;
  if (s.length > MAX_COURIER_CONSIGNEE_NAME_LEN) {
    s = s.slice(0, MAX_COURIER_CONSIGNEE_NAME_LEN).trim();
  }
  return s || fallback;
}

/**
 * Same composition as Shiprocket create-order / Shipmozo push-order street lines.
 * City / state / pincode / country are separate API fields and are NOT included.
 *
 * @param {object} addr
 * @returns {{ line1: string, line2: string, combinedLength: number }}
 */
function buildCourierStreetLines(addr = {}) {
  const line1 = [addr.houseNumber, addr.building, addr.floor, addr.addressLine1]
    .map(trimStr)
    .filter(Boolean)
    .join(', ');
  const line2 = [addr.addressLine2, addr.area, addr.landmark]
    .map(trimStr)
    .filter(Boolean)
    .join(', ');
  return {
    line1,
    line2,
    combinedLength: line1.length + line2.length
  };
}

/**
 * @param {object} addr
 * @returns {{ ok: true, line1: string, line2: string, combinedLength: number } | { ok: false, code: string, message: string, combinedLength: number, max: number }}
 */
function validateCourierComposedStreet(addr = {}) {
  const built = buildCourierStreetLines(addr);
  if (built.combinedLength > MAX_COURIER_COMBINED_STREET_CHARS) {
    return {
      ok: false,
      code: 'COURIER_ADDRESS_TOO_LONG',
      message: `Delivery address is too long for courier shipping (max ${MAX_COURIER_COMBINED_STREET_CHARS} characters for street lines). Please shorten house, building, floor, landmark, or street details. Current: ${built.combinedLength}/${MAX_COURIER_COMBINED_STREET_CHARS}.`,
      combinedLength: built.combinedLength,
      max: MAX_COURIER_COMBINED_STREET_CHARS,
      line1: built.line1,
      line2: built.line2
    };
  }
  return {
    ok: true,
    line1: built.line1,
    line2: built.line2,
    combinedLength: built.combinedLength
  };
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
  const building = trimStr(body.building);
  const floor = trimStr(body.floor);
  const area = trimStr(body.area);
  const landmark = trimStr(body.landmark);
  const city = trimStr(body.city);
  const state = trimStr(body.state);
  const postalCode = trimStr(body.postalCode);
  const country = trimStr(body.country) || 'India';

  if (!fullName) {
    errors.push({ field: 'fullName', code: 'REQUIRED', message: 'Full name is required.' });
  } else if (fullName.length > MAX_FULL_NAME_LEN) {
    errors.push({
      field: 'fullName',
      code: 'FULL_NAME_TOO_LONG',
      message: `Full name is too long (max ${MAX_FULL_NAME_LEN} characters). Enter only the recipient's name — put house, street, landmark, and phone in their own fields.`
    });
  } else if (fullName.length < 2) {
    errors.push({
      field: 'fullName',
      code: 'FULL_NAME_TOO_SHORT',
      message: 'Full name must be at least 2 characters.'
    });
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
  if (building && building.length > 150) {
    errors.push({ field: 'building', code: 'TOO_LONG', message: 'Building name is too long.' });
  }
  if (floor && floor.length > 80) {
    errors.push({ field: 'floor', code: 'TOO_LONG', message: 'Floor details are too long.' });
  }
  if (!area) {
    errors.push({ field: 'area', code: 'REQUIRED', message: 'Area / locality is required.' });
  } else if (area.length < 2) {
    errors.push({ field: 'area', code: 'TOO_SHORT', message: 'Area / locality must be at least 2 characters.' });
  } else if (area.length > 120) {
    errors.push({ field: 'area', code: 'TOO_LONG', message: 'Area / locality is too long.' });
  }
  if (landmark && landmark.length > 150) {
    errors.push({ field: 'landmark', code: 'TOO_LONG', message: 'Landmark must be at most 150 characters.' });
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

  // Courier combined street (Shiprocket / Shipmozo) — only if base street fields parsed OK
  if (street.ok && !errors.some((e) => e.field === 'houseNumber' || e.field === 'area' || e.field === 'landmark')) {
    const courier = validateCourierComposedStreet({
      houseNumber,
      building,
      floor,
      addressLine1: street.line1,
      addressLine2: street.line2,
      area,
      landmark
    });
    if (!courier.ok) {
      errors.push({
        field: 'addressLine1',
        code: courier.code,
        message: courier.message
      });
    }
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
      building,
      floor,
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
  MAX_COURIER_COMBINED_STREET_CHARS,
  MAX_FULL_NAME_LEN,
  MAX_COURIER_CONSIGNEE_NAME_LEN,
  buildCourierStreetLines,
  validateCourierComposedStreet,
  validateStreetLines,
  validatePhysicalAddressForSave,
  shouldRunFullAddressValidation,
  sanitizeCourierConsigneeName,
  ADDRESS_META_ONLY_KEYS
};
