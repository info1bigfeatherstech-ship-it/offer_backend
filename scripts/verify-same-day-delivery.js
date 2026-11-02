/**
 * Isolation checks for same-day delivery (no DB).
 * Run: node scripts/verify-same-day-delivery.js
 */
'use strict';

const assert = require('assert');
const {
  parseDeliveryMode,
  isSameDayQuote,
  isSameDayOrder,
} = require('../sameDayDelivery/utils/sameDayDeliveryMode');
const {
  buildSameDayExclusion,
  buildSameDayPendingMatch,
  buildSameDayShippedMatch,
} = require('../sameDayDelivery/constants/sameDayDeliveryOrderQuery');
const { buildActionPolicy } = require('../services/shipmentOps/actionPolicy');
const { OPS_STATES } = require('../services/shipmentOps/constants');
const { assertEditablePendingOrder } = require('../services/adminPendingOrderEdit.service');
const { evaluateSelfPickupEligibility } = require('../services/selfPickup.service');

function run() {
  assert.strictEqual(parseDeliveryMode(undefined), 'standard');
  assert.strictEqual(parseDeliveryMode(''), 'standard');
  assert.strictEqual(parseDeliveryMode('standard'), 'standard');
  assert.strictEqual(parseDeliveryMode('courier'), 'standard');
  assert.strictEqual(parseDeliveryMode('same_day'), 'same_day');
  assert.strictEqual(parseDeliveryMode('nope'), null);
  assert.strictEqual(isSameDayQuote({ deliveryMode: 'same_day' }), true);
  assert.strictEqual(isSameDayQuote({ deliveryMode: 'standard' }), false);
  assert.strictEqual(isSameDayQuote({}), false);
  assert.strictEqual(isSameDayOrder({ fulfillmentMode: 'same_day' }), true);
  assert.strictEqual(isSameDayOrder({ fulfillmentMode: null }), false);
  assert.strictEqual(isSameDayOrder({}), false);

  assert.deepStrictEqual(buildSameDayExclusion(), { $nor: [{ fulfillmentMode: 'same_day' }] });
  assert.strictEqual(buildSameDayPendingMatch().orderStatus, 'confirmed');
  assert.strictEqual(buildSameDayShippedMatch().orderStatus, 'shipped');

  const sddPolicy = buildActionPolicy({
    opsState: OPS_STATES.READY_TO_SHIP,
    order: {
      fulfillmentMode: 'same_day',
      orderStatus: 'confirmed',
      storefront: 'ecomm',
      shipmentInfo: {},
    },
    fulfillmentPaymentGate: { ok: true },
    canConfirmForFulfillment: true,
  });
  assert.strictEqual(sddPolicy.actionCapabilities.accept, false);
  assert.strictEqual(sddPolicy.actionCapabilities.shipNow, false);
  assert.strictEqual(sddPolicy.actionCapabilities.selfPickup, false);
  assert.strictEqual(sddPolicy.actionCapabilities.cancelShipment, false);

  const standardPolicy = buildActionPolicy({
    opsState: OPS_STATES.AWAITING_APPROVAL,
    order: {
      fulfillmentMode: null,
      orderStatus: 'pending',
      storefront: 'ecomm',
      shipmentInfo: {},
    },
    fulfillmentPaymentGate: { ok: true },
    canConfirmForFulfillment: true,
  });
  assert.strictEqual(standardPolicy.actionCapabilities.accept, true);

  let editBlocked = false;
  try {
    assertEditablePendingOrder({ fulfillmentMode: 'same_day', orderStatus: 'pending' });
  } catch (err) {
    editBlocked = err.code === 'SAME_DAY_USE_SDD_EDIT';
  }
  assert.strictEqual(editBlocked, true);

  const pickup = evaluateSelfPickupEligibility({
    fulfillmentMode: 'same_day',
    orderStatus: 'confirmed',
    storefront: 'ecomm',
  });
  assert.strictEqual(pickup.ok, false);
  assert.strictEqual(pickup.code, 'SELF_PICKUP_SAME_DAY_FORBIDDEN');

  console.log('verify-same-day-delivery: ok');
}

run();
