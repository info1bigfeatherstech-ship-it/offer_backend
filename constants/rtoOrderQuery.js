/**
 * MongoDB helpers for admin RTO tab — bucket is driven by Shiprocket `providerStatus`,
 * not invented sub-statuses. {@link Order#orderStatus} `rto` marks the RTO workflow bucket;
 * the exact label always comes from `shipmentInfo.providerStatus`.
 */

const { isRtoProviderStatus } = require('../services/shipmentOps/shiprocketStatusMap');

/** Case-insensitive match for Shiprocket RTO carrier labels (see isRtoProviderStatus). */
const RTO_PROVIDER_STATUS_REGEX = '\\brto\\b|return to origin|returned to origin';

/**
 * Orders that belong on the admin RTO tab.
 * @returns {import('mongoose').FilterQuery<any>}
 */
function buildRtoBucketMatch() {
  return {
    $or: [
      { orderStatus: 'rto' },
      {
        orderStatus: { $in: ['cancelled', 'delivered'] },
        'shipmentInfo.providerStatus': { $regex: RTO_PROVIDER_STATUS_REGEX, $options: 'i' }
      }
    ]
  };
}

/**
 * Exclude legacy mis-bucketed RTO rows from Cancelled / Delivered tabs.
 * @param {string} bucketKey
 * @returns {import('mongoose').FilterQuery<any>|null}
 */
function buildRtoExclusionForNonRtoBucket(bucketKey) {
  const key = String(bucketKey || '').toLowerCase();
  if (key === 'others') {
    return {
      $or: [
        { orderStatus: { $ne: 'cancelled' } },
        { 'shipmentInfo.providerStatus': { $not: { $regex: RTO_PROVIDER_STATUS_REGEX, $options: 'i' } } },
        { 'shipmentInfo.providerStatus': { $in: [null, ''] } }
      ]
    };
  }
  if (key === 'completed') {
    return {
      $or: [
        { orderStatus: { $ne: 'delivered' } },
        { 'shipmentInfo.providerStatus': { $not: { $regex: RTO_PROVIDER_STATUS_REGEX, $options: 'i' } } },
        { 'shipmentInfo.providerStatus': { $in: [null, ''] } }
      ]
    };
  }
  return null;
}

/**
 * Self-heal: Shiprocket RTO label present but orderStatus still cancelled/delivered.
 * @param {import('mongoose').Document|object} order
 * @returns {boolean}
 */
function repairOrderStatusForShiprocketRto(order) {
  if (!order || typeof order !== 'object') return false;
  const providerStatus = order.shipmentInfo?.providerStatus;
  if (!isRtoProviderStatus(providerStatus)) return false;
  const st = String(order.orderStatus || '').toLowerCase();
  if (st === 'rto') return false;
  if (['cancelled', 'delivered', 'shipped', 'out_for_delivery', 'confirmed', 'processing'].includes(st)) {
    order.orderStatus = 'rto';
    return true;
  }
  return false;
}

/**
 * Whether provider-driven orderStatus may be applied from current state.
 * @param {string|null|undefined} currentStatus
 * @param {string|null|undefined} mappedStatus
 */
function canApplyProviderOrderStatus(currentStatus, mappedStatus) {
  const cur = String(currentStatus || '').toLowerCase();
  const mapped = String(mappedStatus || '').toLowerCase();
  if (!mapped) return false;
  if (mapped === cur) return true;
  if (mapped === 'rto') {
    return ['confirmed', 'processing', 'shipped', 'out_for_delivery', 'delivered', 'cancelled', 'rto'].includes(
      cur
    );
  }
  const forwardEditable = ['confirmed', 'processing', 'shipped', 'out_for_delivery'];
  return !cur || forwardEditable.includes(cur);
}

/**
 * Admin list/detail label — exact Shiprocket text when in RTO flow.
 * @param {string|null|undefined} orderStatus
 * @param {string|null|undefined} providerStatus
 */
function fulfillmentLabelForRtoAwareOrder(orderStatus, providerStatus) {
  const st = String(orderStatus || '').toLowerCase();
  const ps = String(providerStatus || '').trim();
  if (st === 'rto' || isRtoProviderStatus(ps)) {
    return ps || 'RTO';
  }
  return null;
}

module.exports = {
  RTO_PROVIDER_STATUS_REGEX,
  buildRtoBucketMatch,
  buildRtoExclusionForNonRtoBucket,
  repairOrderStatusForShiprocketRto,
  canApplyProviderOrderStatus,
  fulfillmentLabelForRtoAwareOrder,
  isRtoProviderStatus
};
