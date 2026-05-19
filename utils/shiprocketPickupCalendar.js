/**
 * Pickup schedule calendar derived from Shiprocket account / pickup-location settings.
 * Used by admin UI to hide days when pickup is off in the Shiprocket panel.
 */

const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAY_SHORT = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** @returns {string} YYYY-MM-DD in Asia/Kolkata */
function ymdInTimeZone(date, timeZone = 'Asia/Kolkata') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

/** @returns {number} 0=Sunday … 6=Saturday in Asia/Kolkata */
function weekdayIndexInTimeZone(date, timeZone = 'Asia/Kolkata') {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(date).toLowerCase();
  const map = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  return map[name.slice(0, 3)] ?? date.getUTCDay();
}

function normalizeYmd(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  const dt = new Date(s);
  if (!Number.isNaN(dt.getTime())) return ymdInTimeZone(dt);
  return null;
}

function truthyFlag(value) {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  const s = String(value || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'open', 'enabled', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'closed', 'disabled', 'off'].includes(s)) return false;
  return null;
}

function collectLocationRecords(root) {
  if (!root || typeof root !== 'object') return [];
  const out = [];
  const queue = [root];
  const seen = new Set();
  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) queue.push(item);
      continue;
    }
    const nickname =
      node.pickup_location ??
      node.pickupLocation ??
      node.nickname ??
      node.warehouse_name ??
      null;
    const hasAddress = Boolean(node.address || node.pin_code || node.pincode || node.city);
    if (nickname != null || hasAddress) {
      out.push(node);
    }
    for (const v of Object.values(node)) {
      if (v && typeof v === 'object') queue.push(v);
    }
  }
  return out;
}

function pickLocationRecord(records, pickupLocationNickname) {
  const nick = String(pickupLocationNickname || '').trim().toLowerCase();
  if (!nick) return records[0] || null;
  return (
    records.find((r) => String(r.pickup_location || r.pickupLocation || '').trim().toLowerCase() === nick) ||
    records.find((r) => String(r.nickname || '').trim().toLowerCase() === nick) ||
    records[0] ||
    null
  );
}

function parseWeekdayFlagsFromObject(obj) {
  const blocked = new Set();
  if (!obj || typeof obj !== 'object') return blocked;

  for (let i = 0; i < 7; i += 1) {
    const day = WEEKDAY_NAMES[i];
    const short = WEEKDAY_SHORT[i];
    const keyVariants = [
      day,
      short,
      String(i),
      `${day}_pickup`,
      `pickup_${day}`,
      `${day}_enabled`,
      `enable_${day}`,
      `is_${day}_open`,
      `is_${day}_enabled`,
      `${day}_open`,
      `open_${day}`
    ];
    for (const key of keyVariants) {
      if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
      const flag = truthyFlag(obj[key]);
      if (flag === false) blocked.add(i);
      if (flag === true) blocked.delete(i);
    }
  }

  const scheduleNested =
    obj.pickup_schedule || obj.pickupSchedule || obj.schedule || obj.pickup_days_schedule || null;
  if (scheduleNested && typeof scheduleNested === 'object') {
    const nestedBlocked = parseWeekdayFlagsFromObject(scheduleNested);
    for (const d of nestedBlocked) blocked.add(d);
  }

  const arrayKeys = ['pickup_days', 'pickupDays', 'open_days', 'openDays', 'working_days', 'workingDays'];
  for (const ak of arrayKeys) {
    const arr = obj[ak];
    if (!Array.isArray(arr) || arr.length !== 7) continue;
    for (let i = 0; i < 7; i += 1) {
      const flag = truthyFlag(arr[i]);
      if (flag === false) blocked.add(i);
      if (flag === true) blocked.delete(i);
    }
  }

  const closedKeys = ['closed_days', 'closedDays', 'off_days', 'offDays', 'pickup_off_days'];
  for (const ck of closedKeys) {
    const arr = obj[ck];
    if (!Array.isArray(arr)) continue;
    for (const entry of arr) {
      const n = Number(entry);
      if (Number.isFinite(n) && n >= 0 && n <= 6) blocked.add(n);
      const idx = WEEKDAY_NAMES.indexOf(String(entry || '').trim().toLowerCase());
      if (idx >= 0) blocked.add(idx);
    }
  }

  return blocked;
}

function parseHolidaysFromPayload(root) {
  const holidays = new Set();
  const queue = [root];
  const seen = new Set();
  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) {
        if (typeof item === 'string' || typeof item === 'number') {
          const ymd = normalizeYmd(item);
          if (ymd) holidays.add(ymd);
        } else if (item && typeof item === 'object') {
          const ymd = normalizeYmd(item.date || item.holiday_date || item.pickup_date);
          if (ymd) holidays.add(ymd);
        }
      }
      continue;
    }
    for (const [k, v] of Object.entries(node)) {
      if (/holiday/i.test(k) && Array.isArray(v)) {
        for (const item of v) {
          const ymd = normalizeYmd(typeof item === 'object' ? item?.date : item);
          if (ymd) holidays.add(ymd);
        }
      }
      if (v && typeof v === 'object') queue.push(v);
    }
  }
  return holidays;
}

/**
 * @param {object} raw — Shiprocket pickup settings API payload
 * @param {{ pickupLocationNickname?: string }} opts
 */
function mergeBlockedWeekdaySets(...sets) {
  const merged = new Set();
  for (const set of sets) {
    if (!set) continue;
    for (const day of set) merged.add(day);
  }
  return merged;
}

function parsePickupPreferencesFromPayload(raw, opts = {}) {
  const payload = raw && typeof raw === 'object' ? raw : {};
  const dataNode =
    payload.data != null && typeof payload.data === 'object' ? payload.data : null;
  const records = collectLocationRecords(dataNode || payload);
  const location = pickLocationRecord(records, opts.pickupLocationNickname);
  const blockedWeekdays = mergeBlockedWeekdaySets(
    parseWeekdayFlagsFromObject(payload),
    parseWeekdayFlagsFromObject(dataNode),
    parseWeekdayFlagsFromObject(location)
  );
  const holidays = parseHolidaysFromPayload(payload);

  const hasWeekdayRules = blockedWeekdays.size > 0;
  const hasHolidayRules = holidays.size > 0;

  return {
    pickupLocationNickname: opts.pickupLocationNickname || location?.pickup_location || null,
    blockedWeekdays: [...blockedWeekdays].sort((a, b) => a - b),
    holidays: [...holidays].sort(),
    hasScheduleRules: hasWeekdayRules || hasHolidayRules,
    source: hasWeekdayRules || hasHolidayRules ? 'shiprocket_pickup_settings' : 'none',
    locationRecordFound: Boolean(location)
  };
}

/**
 * @param {{ blockedWeekdays?: number[], holidays?: string[] }} preferences
 * @param {{ daysAhead?: number, timeZone?: string }} opts
 */
function buildPickupCalendar(preferences, opts = {}) {
  const daysAhead = Math.min(Math.max(1, Number(opts.daysAhead) || 45), 90);
  const timeZone = opts.timeZone || 'Asia/Kolkata';
  const blocked = new Set(Array.isArray(preferences?.blockedWeekdays) ? preferences.blockedWeekdays : []);
  const holidays = new Set(Array.isArray(preferences?.holidays) ? preferences.holidays : []);

  const todayYmd = ymdInTimeZone(new Date(), timeZone);
  const [ty, tm, td] = todayYmd.split('-').map(Number);
  const start = new Date(Date.UTC(ty, tm - 1, td));

  const dates = [];
  for (let i = 0; i < daysAhead; i += 1) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    const ymd = ymdInTimeZone(d, timeZone);
    const dow = weekdayIndexInTimeZone(d, timeZone);
    let allowed = true;
    let reason = null;
    if (blocked.has(dow)) {
      allowed = false;
      reason = `Pickup is off on ${WEEKDAY_NAMES[dow]} (Shiprocket settings).`;
    } else if (holidays.has(ymd)) {
      allowed = false;
      reason = 'Pickup is off on this date (Shiprocket holiday).';
    }
    dates.push({ date: ymd, allowed, reason });
  }

  const allowedDates = dates.filter((x) => x.allowed).map((x) => x.date);
  return {
    timeZone,
    dates,
    allowedDates,
    defaultDate: allowedDates[0] || null
  };
}

function isPickupDateAllowed(preferences, pickupDateYmd, opts = {}) {
  const cal = buildPickupCalendar(preferences, { daysAhead: 90, ...opts });
  const entry = cal.dates.find((d) => d.date === pickupDateYmd);
  if (!entry) {
    return { allowed: false, reason: 'Invalid or out-of-range pickup date.' };
  }
  return { allowed: entry.allowed, reason: entry.reason };
}

module.exports = {
  WEEKDAY_NAMES,
  ymdInTimeZone,
  weekdayIndexInTimeZone,
  normalizeYmd,
  parsePickupPreferencesFromPayload,
  buildPickupCalendar,
  isPickupDateAllowed
};
