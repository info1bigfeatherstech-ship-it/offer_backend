/**
 * Debug Shiprocket serviceability vs our inactive-courier filter.
 *
 * Usage (from backend/):
 *   node scripts/debug-serviceability-pincode.js 492001
 *   node scripts/debug-serviceability-pincode.js 492001 500
 *   node scripts/debug-serviceability-pincode.js 492001 0 --prod-like
 *
 * --prod-like  clears SHIPROCKET_INACTIVE_* so only code defaults apply (matches prod when env unset)
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const prodLike = process.argv.includes('--prod-like');
if (prodLike) {
  delete process.env.SHIPROCKET_INACTIVE_COURIER_IDS;
  delete process.env.SHIPROCKET_INACTIVE_COURIER_NAME_PATTERNS;
}

const ShiprocketService = require('../utils/shiprocket');
const {
  filterActiveCouriers,
  isCourierInactive,
  resetCourierPolicyCache,
  getInactiveCourierCompanyIds,
  getInactiveCourierNamePatterns,
} = require('../services/courierPolicy.service');

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--prod-like');
  const pincode = String(args[0] || '492001').replace(/\D/g, '').slice(0, 6);
  const codAmount = Number(args[1] || 0) || 0;

  resetCourierPolicyCache();

  console.log('--- config ---');
  console.log({
    pincode,
    pickup: process.env.STORE_PINCODE || process.env.PICKUP_PINCODE,
    weightKg: 0.5,
    codAmount,
    prodLike,
    inactiveIds: getInactiveCourierCompanyIds(),
    inactivePatternSources: getInactiveCourierNamePatterns().map((re) => String(re)),
    shiprocketEnabled: process.env.SHIPROCKET_ENABLED,
  });

  const listRes = await ShiprocketService.listCouriersForRoute(pincode, {
    weightKg: 0.5,
    lengthCm: 10,
    widthCm: 10,
    heightCm: 10,
    codAmount,
  });

  if (!listRes.success) {
    console.log('\n--- listCouriersForRoute FAILED ---');
    console.log(listRes);
  }

  const raw = listRes.couriers || [];
  console.log('\n--- RAW from Shiprocket ---');
  console.log('count:', raw.length);
  console.log(
    raw.map((c) => ({
      id: c.courier_company_id || c.id,
      name: c.courier_name || c.name,
      rate: c.rate ?? c.freight_charge,
      inactiveByPolicy: isCourierInactive(c),
    }))
  );

  const active = filterActiveCouriers(raw);
  console.log('\n--- AFTER our filter ---');
  console.log('active count:', active.length);
  console.log(
    active.map((c) => ({
      id: c.courier_company_id || c.id,
      name: c.courier_name || c.name,
      rate: c.rate ?? c.freight_charge,
    }))
  );

  const quote = await ShiprocketService.checkDeliveryAvailability(pincode, {
    weightKg: 0.5,
    lengthCm: 10,
    widthCm: 10,
    heightCm: 10,
    codAmount,
  });

  console.log('\n--- checkDeliveryAvailability (website/checkout path) ---');
  console.log(quote);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
