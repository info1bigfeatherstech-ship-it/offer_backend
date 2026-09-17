/**
 * Courier collectable COD lock — unit tests.
 * Run: node scripts/test-courier-collectable-lock.js
 */
const assert = require('assert');
const {
  computeLiveCourierCollectable,
  hasCourierCollectableLock,
  getCustomerFacingCollectableInr,
  getCustomerFacingDeliveryInr,
  getCustomerFacingOrderTotalInr,
  applyCourierCollectableLock,
  resolveLockAmountFromShipmentResult
} = require('../services/courierCollectableLock.service');

function partialOrder(overrides = {}) {
  return {
    totalAmount: 483.08,
    amountPaidInr: 245.64,
    balanceDueInr: 237.44,
    paymentInfo: {
      method: 'online',
      balanceCollectionMethod: 'cod',
      splitMode: 'advance'
    },
    shipmentInfo: {},
    ...overrides
  };
}

console.log('1) Live collectable for partial');
{
  const o = partialOrder();
  const live = computeLiveCourierCollectable(o);
  assert.strictEqual(live.useCodAtDoor, true);
  assert.strictEqual(live.collectableInr, 237.44);
}

console.log('2) Lock once, never overwrite');
{
  const o = partialOrder();
  const first = applyCourierCollectableLock(o, { amountInr: 338.92, source: 'shipmozo_push' });
  assert.strictEqual(first.locked, true);
  assert.strictEqual(first.amountInr, 338.92);
  assert.strictEqual(o.shipmentInfo.courierCollectableInr, 338.92);

  // Simulate Ship Now lowering internal due
  o.balanceDueInr = 237.44;
  o.totalAmount = 483.08;

  const second = applyCourierCollectableLock(o, { amountInr: 237.44, source: 'ship_now' });
  assert.strictEqual(second.alreadyLocked, true);
  assert.strictEqual(o.shipmentInfo.courierCollectableInr, 338.92);
  assert.strictEqual(getCustomerFacingCollectableInr(o), 338.92);
  assert.strictEqual(hasCourierCollectableLock(o), true);
}

console.log('3) Prepaid lock amount 0 from result');
{
  const o = {
    totalAmount: 500,
    amountPaidInr: 500,
    balanceDueInr: 0,
    paymentInfo: { method: 'online' },
    shipmentInfo: {}
  };
  const amt = resolveLockAmountFromShipmentResult(o, { codCollectInr: 0 });
  assert.strictEqual(amt, 0);
  applyCourierCollectableLock(o, { amountInr: amt, source: 'shiprocket_push' });
  assert.strictEqual(getCustomerFacingCollectableInr(o), 0);
}

console.log('4) Pure COD uses total');
{
  const o = {
    totalAmount: 900,
    amountPaidInr: 0,
    balanceDueInr: 900,
    paymentInfo: { method: 'cod' },
    shipmentInfo: {}
  };
  assert.strictEqual(computeLiveCourierCollectable(o).collectableInr, 900);
}

console.log('5) Prefer shipment result amount over live');
{
  const o = partialOrder({ balanceDueInr: 100 });
  const amt = resolveLockAmountFromShipmentResult(o, { codCollectInr: 720.07 });
  assert.strictEqual(amt, 720.07);
}

console.log('6) Freeze delivery + total at push; Ship Now must not change customer view');
{
  const o = partialOrder({
    deliveryCharges: 620.43,
    totalAmount: 1719.43,
    balanceDueInr: 1555.96,
    amountPaidInr: 163.47
  });
  const first = applyCourierCollectableLock(o, {
    amountInr: 1555.96,
    deliveryInr: 620.43,
    totalInr: 1719.43,
    source: 'shipmozo_push'
  });
  assert.strictEqual(first.locked, true);
  assert.strictEqual(o.shipmentInfo.courierDeliveryInr, 620.43);
  assert.strictEqual(o.shipmentInfo.courierFacingTotalInr, 1719.43);

  o.deliveryCharges = 272.58;
  o.totalAmount = 1631.58;
  o.balanceDueInr = 1468.11;

  assert.strictEqual(getCustomerFacingDeliveryInr(o), 620.43);
  assert.strictEqual(getCustomerFacingOrderTotalInr(o), 1719.43);
  assert.strictEqual(getCustomerFacingCollectableInr(o), 1555.96);
}

console.log('\nAll courier collectable lock tests PASSED');
