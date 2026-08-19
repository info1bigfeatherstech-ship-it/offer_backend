/**
 * Maps dashboard UI fulfillment tabs (reference: admin Orders screen) to internal
 * {@link Order#orderStatus} values. Adjust here if your ops workflow changes.
 *
 * Note: `ready_to_ship` / `ready_to_pick` both map to `processing` and are split by
 * whether the shipping label has been downloaded (`shipmentInfo.labelDownloaded`).
 * `pickup_exception` and `rto` tabs are providerStatus-aware
 * (see pickupExceptionOrderQuery / rtoOrderQuery).
 */

const { fulfillmentLabelForRtoAwareOrder } = require('./rtoOrderQuery');
const {
  fulfillmentLabelForPickupExceptionAwareOrder
} = require('./pickupExceptionOrderQuery');

/** @typedef {'all'|'new'|'bill_sent'|'ready_to_ship'|'ready_to_pick'|'in_transit'|'completed'|'rto'|'pickup_exception'|'others'} AdminOrderBucketKey */

/** @type {Record<Exclude<AdminOrderBucketKey, 'all'>, string[]>} */
const BUCKET_TO_ORDER_STATUSES = Object.freeze({
  /** Awaiting payment / first touch */
  new: ['pending'],
  /** Order accepted; ready for invoicing / packing queue */
  bill_sent: ['confirmed'],
  /** Ready to ship */
  ready_to_ship: ['processing'],
  /** Warehouse / fulfilment */
  ready_to_pick: ['processing'],
  /** Courier handoff */
  in_transit: ['shipped', 'out_for_delivery'],
  /** Delivered to customer */
  completed: ['delivered', 'return_requested'],
  /** Shiprocket RTO flow — exact carrier label in shipmentInfo.providerStatus */
  rto: ['rto'],
  /** Pickup exception — also matched via providerStatus (see pickupExceptionOrderQuery) */
  pickup_exception: ['pickup_exception'],
  /** Terminal / exceptional */
  others: ['cancelled', 'payment_failed']
});

/** Statuses that count as “still in pipeline” for summary card “pending” */
const PIPELINE_ORDER_STATUSES = Object.freeze([
  'pending',
  'confirmed',
  'processing',
  'shipped',
  'out_for_delivery'
]);

/** Revenue / GMV: include these (exclude cancelled & payment_failed) */
const GMV_EXCLUDED_ORDER_STATUSES = Object.freeze(['cancelled', 'payment_failed']);

/**
 * Panel tab buckets whose orders may still have an in-flight Shiprocket forward shipment.
 * Derived from {@link BUCKET_TO_ORDER_STATUSES} — excludes terminal tabs (Delivered, Cancelled/others).
 * Single source of truth for admin auto-sync eligibility (do not duplicate status lists elsewhere).
 *
 * Pickup Exception stays on `processing`/`confirmed` in DB so auto-sync still refreshes those rows.
 */
const ACTIVE_FORWARD_SYNC_BUCKET_KEYS = Object.freeze([
  'new',
  'bill_sent',
  'ready_to_ship',
  'ready_to_pick',
  'in_transit'
]);

/** @type {readonly string[]} */
const ACTIVE_FORWARD_SYNC_STATUSES = Object.freeze(
  ACTIVE_FORWARD_SYNC_BUCKET_KEYS.flatMap((key) => BUCKET_TO_ORDER_STATUSES[key] || [])
);

/**
 * @param {string} orderStatus
 */
function isActiveForwardSyncOrderStatus(orderStatus) {
  return ACTIVE_FORWARD_SYNC_STATUSES.includes(String(orderStatus || '').trim());
}

/**
 * @param {string} orderStatus
 * @returns {keyof typeof BUCKET_TO_ORDER_STATUSES | 'all'}
 */
function fulfillmentBucketKeyFromOrderStatus(orderStatus) {
  for (const [key, statuses] of Object.entries(BUCKET_TO_ORDER_STATUSES)) {
    if (statuses.includes(orderStatus)) return /** @type {any} */ (key);
  }
  return 'others';
}

/**
 * Human-readable label from DB orderStatus (RTO / pickup-exception aware).
 * Prefer {@link fulfillmentLabelForAdminListRow} for the admin Orders table STATUS column.
 * @param {string} orderStatus
 * @param {string} [providerStatus]
 */
function fulfillmentLabelFromOrderStatus(orderStatus, providerStatus, order) {
  const rtoLabel = fulfillmentLabelForRtoAwareOrder(orderStatus, providerStatus, order);
  if (rtoLabel) return rtoLabel;

  const pickupExceptionLabel = fulfillmentLabelForPickupExceptionAwareOrder(
    orderStatus,
    providerStatus
  );
  if (pickupExceptionLabel) return pickupExceptionLabel;

  const map = {
    pending: 'Pending',
    confirmed: 'Confirmed',
    processing: 'Processing',
    shipped: 'Shipped',
    out_for_delivery: 'Out for delivery',
    delivered: 'Delivered',
    cancelled: 'Cancelled',
    return_requested: 'Return requested',
    payment_failed: 'Payment failed',
    pickup_exception: 'Pickup Exception',
    rto: providerStatus ? String(providerStatus).trim() : 'RTO'
  };
  const key = String(orderStatus || '').trim();
  if (map[key]) return map[key];
  return key ? key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '—';
}

/**
 * Admin Orders list STATUS pill — aligns with tab semantics without mutating DB status.
 * - Pickup Exception / RTO: exception-aware labels
 * - Ready to Ship bucket: "Ready to Ship" (not raw "Processing")
 * - Processing (ready_to_pick) bucket: "Processing"
 *
 * @param {string} orderStatus
 * @param {string|null|undefined} providerStatus
 * @param {string} bucketKey
 */
function fulfillmentLabelForAdminListRow(orderStatus, providerStatus, bucketKey, order) {
  const rtoLabel = fulfillmentLabelForRtoAwareOrder(orderStatus, providerStatus, order);
  if (rtoLabel) return rtoLabel;

  const pickupExceptionLabel = fulfillmentLabelForPickupExceptionAwareOrder(
    orderStatus,
    providerStatus
  );
  if (pickupExceptionLabel) return pickupExceptionLabel;

  const bucket = String(bucketKey || '').toLowerCase();
  if (bucket === 'ready_to_ship') return 'Ready to Ship';
  if (bucket === 'pickup_exception') return 'Pickup Exception';

  return fulfillmentLabelFromOrderStatus(orderStatus, providerStatus, order);
}

/**
 * @param {string} paymentStatus
 */
function paymentLabelForUi(paymentStatus) {
  const map = {
    pending: 'Pending',
    initiated: 'Initiated',
    paid: 'Paid',
    failed: 'Failed',
    refunded: 'Refunded',
    partially_paid: 'Partially paid',
    partially_refunded: 'Partially refunded'
  };
  const key = String(paymentStatus || '').trim();
  if (map[key]) return map[key];
  return key ? key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '—';
}

module.exports = {
  BUCKET_TO_ORDER_STATUSES,
  PIPELINE_ORDER_STATUSES,
  GMV_EXCLUDED_ORDER_STATUSES,
  ACTIVE_FORWARD_SYNC_BUCKET_KEYS,
  ACTIVE_FORWARD_SYNC_STATUSES,
  isActiveForwardSyncOrderStatus,
  fulfillmentBucketKeyFromOrderStatus,
  fulfillmentLabelFromOrderStatus,
  fulfillmentLabelForAdminListRow,
  paymentLabelForUi
};
