/**
 * Courier allow/block policy — optional env-driven only.
 * Inactive couriers are excluded from checkout quotes; Ship Now falls back to next cheapest active courier.
 *
 * No hardcoded courier blocks. Set explicitly if needed:
 *   SHIPROCKET_INACTIVE_COURIER_IDS=12,34
 *   SHIPROCKET_INACTIVE_COURIER_NAME_PATTERNS=Amazon Prepaid Surface|Amazon.*Surface
 */

let cachedInactiveIds = null;
let cachedNamePatterns = null;

/**
 * @returns {number[]}
 */
function getInactiveCourierCompanyIds() {
  if (cachedInactiveIds) return cachedInactiveIds;
  const raw = String(process.env.SHIPROCKET_INACTIVE_COURIER_IDS || '').trim();
  cachedInactiveIds = raw
    ? raw
        .split(/[,;\s]+/)
        .map((x) => Number(String(x).trim()))
        .filter((n) => Number.isFinite(n) && n > 0)
    : [];
  return cachedInactiveIds;
}

/**
 * @returns {RegExp[]}
 */
function getInactiveCourierNamePatterns() {
  if (cachedNamePatterns) return cachedNamePatterns;
  const raw = String(process.env.SHIPROCKET_INACTIVE_COURIER_NAME_PATTERNS || '').trim();
  if (!raw) {
    cachedNamePatterns = [];
    return cachedNamePatterns;
  }
  cachedNamePatterns = raw
    .split('|')
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .map((part) => {
      try {
        return new RegExp(part, 'i');
      } catch {
        return new RegExp(part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      }
    });
  return cachedNamePatterns;
}

/** Test helper — reset env cache between tests. */
function resetCourierPolicyCache() {
  cachedInactiveIds = null;
  cachedNamePatterns = null;
}

/**
 * @param {object|null|undefined} courier — Shiprocket serviceability row or { id, name }
 */
function getCourierCompanyIdFromRow(courier) {
  if (!courier || typeof courier !== 'object') return null;
  if (courier.id != null && courier.name != null && courier.courier_company_id == null) {
    const n = Number(courier.id);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const raw =
    courier.courier_company_id ??
    courier.courier_id ??
    courier.company_id ??
    courier.id ??
    null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * @param {object|null|undefined} courier
 */
function getCourierNameFromRow(courier) {
  if (!courier || typeof courier !== 'object') return '';
  return String(courier.courier_name || courier.airline_name || courier.name || '').trim();
}

/**
 * @param {{ id?: number|null, name?: string|null }|object|null|undefined} courier
 */
function isCourierInactive(courier) {
  const id = getCourierCompanyIdFromRow(courier);
  const name = getCourierNameFromRow(courier) || String(courier?.name || '').trim();
  const inactiveIds = getInactiveCourierCompanyIds();
  if (id != null && inactiveIds.includes(id)) return true;
  const patterns = getInactiveCourierNamePatterns();
  if (!name) return false;
  return patterns.some((re) => re.test(name));
}

/**
 * @param {Array<object>} couriers
 * @returns {Array<object>}
 */
function filterActiveCouriers(couriers) {
  if (!Array.isArray(couriers)) return [];
  return couriers.filter((c) => !isCourierInactive(c));
}

/**
 * Pick cheapest active courier (same logic as ShiprocketService.pickRecommendedCourierId).
 * When maxCharge is set, prefer cheapest with rate <= maxCharge; else overall cheapest.
 * @param {Array<object>} couriers
 * @param {{ codRequired?: boolean, maxCharge?: number|null }} [opts]
 * @returns {{ courier: object, courierCompanyId: number, courierName: string, rate: number }|null}
 */
function pickCheapestActiveCourier(couriers, opts = {}) {
  const active = filterActiveCouriers(couriers);
  if (!active.length) return null;

  const needCod = Boolean(opts.codRequired);
  const filtered = needCod
    ? active.filter(
        (c) =>
          c.cod === 1 ||
          c.cod === true ||
          c.is_cod_available === 1 ||
          c.is_cod_available === true
      )
    : active;
  const pool = filtered.length ? filtered : active;

  const scored = pool.map((c) => {
    const rate = Number(c.rate ?? c.freight_charge ?? Infinity);
    const etd = Number(c.estimated_delivery_days ?? c.etd ?? c.etd_hours ?? 999);
    return { c, rate: Number.isFinite(rate) ? rate : Infinity, etd: Number.isFinite(etd) ? etd : 999 };
  });
  scored.sort((a, b) => {
    if (a.rate !== b.rate) return a.rate - b.rate;
    return a.etd - b.etd;
  });

  let chosen = scored[0];
  const maxCharge = opts.maxCharge;
  if (maxCharge != null && Number.isFinite(Number(maxCharge))) {
    const cap = Number(maxCharge) + 0.05;
    const under = scored.filter((s) => s.rate <= cap);
    if (under.length) chosen = under[0];
  }

  const top = chosen?.c;
  if (!top) return null;
  const courierCompanyId = getCourierCompanyIdFromRow(top);
  if (courierCompanyId == null) return null;
  return {
    courier: top,
    courierCompanyId,
    courierName: getCourierNameFromRow(top) || 'Courier',
    rate: Number.isFinite(chosen.rate) ? chosen.rate : null
  };
}

/**
 * Build admin-facing note when checkout courier was skipped at assign time.
 * @param {{ quotedId?: number|null, quotedName?: string|null, assignedId: number, assignedName: string, reason?: string|null }} params
 */
function buildCourierSubstituteNote(params) {
  const quotedLabel = params.quotedName
    ? `"${params.quotedName}"${params.quotedId ? ` (ID ${params.quotedId})` : ''}`
    : params.quotedId
      ? `ID ${params.quotedId}`
      : 'checkout courier';
  const reason = String(params.reason || 'inactive_policy').trim();
  if (reason === 'inactive_policy') {
    return (
      `Quoted courier ${quotedLabel} is inactive in our shipping policy. ` +
      `Assigned next cheapest active courier: "${params.assignedName}" (ID ${params.assignedId}). Customer bill unchanged.`
    );
  }
  if (reason === 'assign_failed' || reason === 'admin_confirm') {
    return (
      `Quoted courier ${quotedLabel} could not be assigned on Shiprocket. ` +
      `Assigned substitute "${params.assignedName}" (ID ${params.assignedId}) after admin confirm. Customer bill unchanged.`
    );
  }
  return (
    `Quoted courier ${quotedLabel} was not used. ` +
    `Assigned "${params.assignedName}" (ID ${params.assignedId}). Customer bill unchanged.`
  );
}

module.exports = {
  getInactiveCourierCompanyIds,
  getInactiveCourierNamePatterns,
  resetCourierPolicyCache,
  getCourierCompanyIdFromRow,
  getCourierNameFromRow,
  isCourierInactive,
  filterActiveCouriers,
  pickCheapestActiveCourier,
  buildCourierSubstituteNote
};
