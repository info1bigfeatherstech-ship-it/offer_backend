'use strict';

/**
 * Admin Orders tab: Self pickup bucket (warehouse handover).
 * Matches fulfillmentMode / providerStatus — not a separate orderStatus.
 */

function isSelfPickupOrder(order) {
  if (!order) return false;
  if (String(order.fulfillmentMode || '').toLowerCase() === 'self_pickup') return true;
  return String(order.shipmentInfo?.providerStatus || '').toUpperCase() === 'SELF_PICKUP';
}

/** Mongo match for Self pickup tab */
function buildSelfPickupBucketMatch() {
  return {
    $or: [
      { fulfillmentMode: 'self_pickup' },
      { 'shipmentInfo.providerStatus': 'SELF_PICKUP' }
    ]
  };
}

/**
 * Exclude self-pickup rows from Delivered / other courier tabs.
 * @param {string} [_bucket] unused — same exclusion for all non-self-pickup buckets
 */
function buildSelfPickupExclusionForNonSelfPickupBucket(_bucket) {
  return {
    $nor: [
      { fulfillmentMode: 'self_pickup' },
      { 'shipmentInfo.providerStatus': 'SELF_PICKUP' }
    ]
  };
}

module.exports = {
  isSelfPickupOrder,
  buildSelfPickupBucketMatch,
  buildSelfPickupExclusionForNonSelfPickupBucket
};
