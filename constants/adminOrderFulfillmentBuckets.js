/**
 * Maps dashboard UI fulfillment tabs (reference: admin Orders screen) to internal
 * {@link Order#orderStatus} values. Adjust here if your ops workflow changes.
 */

/** @typedef {'all'|'new'|'bill_sent'|'ready_to_pick'|'in_transit'|'completed'|'others'} AdminOrderBucketKey */

/** @type {Record<Exclude<AdminOrderBucketKey, 'all'>, string[]>} */
const BUCKET_TO_ORDER_STATUSES = Object.freeze({
  /** Awaiting payment / first touch */
  new: ['pending'],
  /** Order accepted; ready for invoicing / packing queue */
  bill_sent: ['confirmed'],
  /** Warehouse / fulfilment */
  ready_to_pick: ['processing'],
  /** Courier handoff */
  in_transit: ['shipped', 'out_for_delivery'],
  /** Delivered to customer */
  completed: ['delivered'],
  /** Terminal / exceptional */
  others: ['cancelled', 'return_requested', 'payment_failed']
});

/** Statuses that count as “still in pipeline” for summary card “pending” */
const PIPELINE_ORDER_STATUSES = Object.freeze([
  'pending',
  'confirmed',
  'processing',
  'shipped',
  'out_for_delivery',
  'return_requested'
]);

/** Revenue / GMV: include these (exclude cancelled & payment_failed) */
const GMV_EXCLUDED_ORDER_STATUSES = Object.freeze(['cancelled', 'payment_failed']);

/**
 * Panel tab buckets whose orders may still have an in-flight Shiprocket forward shipment.
 * Derived from {@link BUCKET_TO_ORDER_STATUSES} — excludes terminal tabs (Delivered, Cancelled/others).
 * Single source of truth for admin auto-sync eligibility (do not duplicate status lists elsewhere).
 */
const ACTIVE_FORWARD_SYNC_BUCKET_KEYS = Object.freeze(['new', 'bill_sent', 'ready_to_pick', 'in_transit']);

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
 * Human-readable label for {@link Order#orderStatus} — matches schema enum, not legacy bucket nicknames.
 * @param {string} orderStatus
 */
function fulfillmentLabelFromOrderStatus(orderStatus) {
  const map = {
    pending: 'Pending',
    confirmed: 'Confirmed',
    processing: 'Processing',
    shipped: 'Shipped',
    out_for_delivery: 'Out for delivery',
    delivered: 'Delivered',
    cancelled: 'Cancelled',
    return_requested: 'Return requested',
    payment_failed: 'Payment failed'
  };
  const key = String(orderStatus || '').trim();
  if (map[key]) return map[key];
  return key ? key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '—';
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
  paymentLabelForUi
};
