/**
 * Compares OLD production Shiprocket payload (order_total bug) vs fixed payload.
 * Run: node scripts/compare-partial-cod-payloads.js
 */
const path = require('path');

const order = {
  orderId: 'OWB-ECOMM-3072-TEST',
  totalAmount: 194.36,
  subtotal: 79,
  deliveryCharges: 115.36,
  amountPaidInr: 48.59,
  balanceDueInr: 145.77,
  paymentStatus: 'partially_paid',
  paymentInfo: {
    method: 'online',
    splitMode: 'advance',
    balanceCollectionMethod: 'cod',
    advancePercent: 25
  }
};

const orderItems = [
  { name: '300ML Oil Dispenser Bottle', sku: 'SKU-2634-1', units: 1, selling_price: 79, discount: 0, tax: '', hsn: '' }
];

const roundMoney2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function buildOldProductionPayload() {
  const payMethod = 'online';
  const balanceViaCod = true;
  const splitAdv = true;
  const useCodAtDoor = payMethod === 'online' && balanceViaCod && splitAdv;
  const payload = {
    payment_method: useCodAtDoor ? 'COD' : 'Prepaid',
    sub_total: order.subtotal,
    shipping_charges: order.deliveryCharges,
    order_items: orderItems
  };
  if (useCodAtDoor && payMethod === 'online' && balanceViaCod) {
    const collect = roundMoney2(order.balanceDueInr);
    if (collect > 0) payload.order_total = collect;
  }
  const shiprocketDisplayTotal = roundMoney2(payload.sub_total + payload.shipping_charges);
  return { payload, shiprocketDisplayTotal };
}

const ShiprocketService = require(path.join(__dirname, '..', 'utils', 'shiprocket.js'));
const parts = {
  useCodAtDoor: true,
  payMethod: 'online',
  balanceViaCod: true,
  splitAdv: true,
  codCollect: 145.77
};
const fixedPayload = ShiprocketService.finalizeAdhocCreatePayload(
  { payment_method: 'COD', sub_total: 79, shipping_charges: 115.36 },
  order,
  parts,
  orderItems
);

const old = buildOldProductionPayload();

console.log('=== OLD PRODUCTION (live bug) ===');
console.log(JSON.stringify(old.payload, null, 2));
console.log('Shiprocket would show ~', old.shiprocketDisplayTotal, '(sub_total + shipping, ignores order_total)');

console.log('\n=== FIXED PAYLOAD ===');
console.log(JSON.stringify({
  payment_method: fixedPayload.payment_method,
  sub_total: fixedPayload.sub_total,
  shipping_charges: fixedPayload.shipping_charges,
  total: fixedPayload.total,
  cod_amount: fixedPayload.cod_amount,
  order_items: fixedPayload.order_items
}, null, 2));
