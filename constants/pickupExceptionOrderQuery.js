/**
 * MongoDB helpers for admin Pickup Exception tab.
 *
 * Same production pattern as {@link ./rtoOrderQuery}: the tab is driven primarily by
 * Shiprocket `shipmentInfo.providerStatus` (plus optional `orderStatus: pickup_exception`).
 * We do **not** mutate {@link Order#orderStatus} to `pickup_exception` here — that would
 * risk fulfillment / auto-sync side effects. List bucketing stays read-model only.
 */

const { isRtoProviderStatus, RTO_PROVIDER_STATUS_REGEX } = require('./rtoOrderQuery');
const { PICKUP_EXCEPTION_PROVIDER_STATUS_REGEX } = require('./pickupExceptionSignals');

/** Forward statuses where a pickup exception is actionable on the admin Orders screen. */
const PICKUP_EXCEPTION_FORWARD_ORDER_STATUSES = Object.freeze(['confirmed', 'processing', 'pickup_exception']);

/**
 * Buckets that must not list pickup-exception rows (they belong on Pickup Exception).
 * @type {ReadonlySet<string>}
 */
const BUCKETS_EXCLUDING_PICKUP_EXCEPTION = Object.freeze(
  new Set(['bill_sent', 'ready_to_ship', 'ready_to_pick'])
);

/**
 * @param {string|null|undefined} providerStatus
 * @returns {boolean}
 */
function isPickupExceptionProviderStatus(providerStatus) {
  const s = String(providerStatus || '').trim();
  if (!s) return false;
  return new RegExp(PICKUP_EXCEPTION_PROVIDER_STATUS_REGEX, 'i').test(s);
}

/**
 * Whether this order belongs on the admin Pickup Exception tab (list / counts).
 * RTO always wins over pickup-exception bucketing.
 *
 * @param {{ orderStatus?: string, shipmentInfo?: { providerStatus?: string|null } }|null|undefined} order
 * @returns {boolean}
 */
function isPickupExceptionAdminBucketOrder(order) {
  if (!order || typeof order !== 'object') return false;
  const providerStatus = order.shipmentInfo?.providerStatus;
  if (isRtoProviderStatus(providerStatus) || String(order.orderStatus || '').toLowerCase() === 'rto') {
    return false;
  }
  const st = String(order.orderStatus || '').toLowerCase();
  if (st === 'pickup_exception') return true;
  if (!PICKUP_EXCEPTION_FORWARD_ORDER_STATUSES.includes(st)) return false;
  return isPickupExceptionProviderStatus(providerStatus);
}

/**
 * Orders that belong on the admin Pickup Exception tab.
 * @returns {import('mongoose').FilterQuery<any>}
 */
function buildPickupExceptionBucketMatch() {
  return {
    $and: [
      {
        $or: [
          { orderStatus: 'pickup_exception' },
          {
            orderStatus: { $in: ['confirmed', 'processing'] },
            'shipmentInfo.providerStatus': {
              $regex: PICKUP_EXCEPTION_PROVIDER_STATUS_REGEX,
              $options: 'i'
            }
          }
        ]
      },
      // Never steal RTO rows into this tab.
      { orderStatus: { $ne: 'rto' } },
      {
        $or: [
          { 'shipmentInfo.providerStatus': { $exists: false } },
          { 'shipmentInfo.providerStatus': { $in: [null, ''] } },
          {
            'shipmentInfo.providerStatus': {
              $not: { $regex: RTO_PROVIDER_STATUS_REGEX, $options: 'i' }
            }
          }
        ]
      }
    ]
  };
}

/**
 * Exclude pickup-exception rows from Confirmed / Ready to Ship / Processing tabs.
 * @param {string} bucketKey
 * @returns {import('mongoose').FilterQuery<any>|null}
 */
function buildPickupExceptionExclusionForNonExceptionBucket(bucketKey) {
  const key = String(bucketKey || '').toLowerCase();
  if (!BUCKETS_EXCLUDING_PICKUP_EXCEPTION.has(key)) return null;
  return {
    $and: [
      { orderStatus: { $ne: 'pickup_exception' } },
      {
        $or: [
          { 'shipmentInfo.providerStatus': { $exists: false } },
          { 'shipmentInfo.providerStatus': { $in: [null, ''] } },
          {
            'shipmentInfo.providerStatus': {
              $not: { $regex: PICKUP_EXCEPTION_PROVIDER_STATUS_REGEX, $options: 'i' }
            }
          }
        ]
      }
    ]
  };
}

/**
 * Admin list STATUS pill — Pickup Exception (exact product label).
 * @param {string|null|undefined} orderStatus
 * @param {string|null|undefined} providerStatus
 * @returns {string|null}
 */
function fulfillmentLabelForPickupExceptionAwareOrder(orderStatus, providerStatus) {
  if (
    isPickupExceptionAdminBucketOrder({
      orderStatus,
      shipmentInfo: { providerStatus }
    })
  ) {
    return 'Pickup Exception';
  }
  return null;
}

module.exports = {
  PICKUP_EXCEPTION_PROVIDER_STATUS_REGEX,
  PICKUP_EXCEPTION_FORWARD_ORDER_STATUSES,
  BUCKETS_EXCLUDING_PICKUP_EXCEPTION,
  isPickupExceptionProviderStatus,
  isPickupExceptionAdminBucketOrder,
  buildPickupExceptionBucketMatch,
  buildPickupExceptionExclusionForNonExceptionBucket,
  fulfillmentLabelForPickupExceptionAwareOrder
};
