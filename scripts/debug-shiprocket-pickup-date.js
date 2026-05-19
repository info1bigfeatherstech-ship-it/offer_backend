/**
 * Live diagnostic — pickup date resolution for a Shiprocket order.
 * Usage: node scripts/debug-shiprocket-pickup-date.js [shiprocketOrderId] [channelOrderId]
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const shiprocket = require('../utils/shiprocket');
const ShiprocketService = shiprocket.constructor;

const srOrderId = process.argv[2] || '1350319109';
const channelOrderId = process.argv[3] || '';

async function dump(label, fn) {
  try {
    const result = await fn();
    console.log(`\n=== ${label} ===`);
    console.log(JSON.stringify(result, null, 2).slice(0, 12000));
    return result;
  } catch (e) {
    console.log(`\n=== ${label} FAILED ===`);
    console.log(e.response?.status, e.response?.data || e.message);
    return null;
  }
}

async function main() {
  console.log('Shiprocket enabled:', shiprocket.enabled);
  if (!shiprocket.enabled) {
    console.error('SHIPROCKET_ENABLED is not true');
    process.exit(1);
  }

  const show = await dump('orders/show', () =>
    shiprocket.fetchForwardOrderSnapshot({
      shiprocketOrderId: srOrderId,
      channelOrderId: channelOrderId || undefined
    })
  );

  const sid = show?.snapshot?.shipmentId;
  const oid = show?.snapshot?.shiprocketOrderId || srOrderId;
  console.log('\nResolved ids:', { shipmentId: sid, shiprocketOrderId: oid, channelOrderId });

  await dump('pickup list (full)', () => shiprocket.fetchPickupDateForShipment({
    shipmentId: sid,
    shiprocketOrderId: oid,
    channelOrderId: channelOrderId || undefined
  }));

  await dump('resolveAuthoritativePickupDate', () =>
    shiprocket.resolveAuthoritativePickupDate({
      shipmentId: sid,
      shiprocketOrderId: oid,
      channelOrderId: channelOrderId || undefined
    })
  );

  if (show?.raw) {
    const strict = ShiprocketService.extractStrictPickupScheduledDateFromOrderShow(show.raw);
    const batchParse = sid
      ? ShiprocketService.findPickupDateInPickupListPayload(
          await shiprocket.requestWithAuth({
            method: 'get',
            url: `${shiprocket.baseURL}/external/pickup/pickupids`,
            params: { per_page: 100, page: 1 },
            timeout: 25000
          }),
          { shipmentId: sid, shiprocketOrderId: oid }
        )
      : null;
    console.log('\n=== parser probes ===');
    console.log({ strict, batchParse });
  }

  const outDir = path.join(__dirname, '../logs');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `pickup-debug-${srOrderId}.json`);
  fs.writeFileSync(
    outFile,
    JSON.stringify({ show, at: new Date().toISOString() }, null, 2).slice(0, 500000)
  );
  console.log('\nWrote', outFile);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
