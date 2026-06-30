/**
 * Canonical shipment operations states and action keys.
 * Internal states are stable; Shiprocket provider labels map into these.
 */

const OPS_STATES = Object.freeze({
  AWAITING_APPROVAL: 'AWAITING_APPROVAL',
  READY_TO_SHIP: 'READY_TO_SHIP',
  AWB_ASSIGNED: 'AWB_ASSIGNED',
  PICKUP_SCHEDULED: 'PICKUP_SCHEDULED',
  MANIFEST_READY: 'MANIFEST_READY',
  LABEL_READY: 'LABEL_READY',
  IN_TRANSIT: 'IN_TRANSIT',
  OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
  DELIVERED: 'DELIVERED',
  RTO: 'RTO',
  PICKUP_EXCEPTION: 'PICKUP_EXCEPTION',
  PROVIDER_RESET: 'PROVIDER_RESET',
  CANCELLED: 'CANCELLED',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  NEEDS_MANUAL_REVIEW: 'NEEDS_MANUAL_REVIEW',
  NONE: 'NONE',
});

const OPS_STATE_LABELS = Object.freeze({
  [OPS_STATES.AWAITING_APPROVAL]: 'Awaiting approval',
  [OPS_STATES.READY_TO_SHIP]: 'Ready to ship',
  [OPS_STATES.AWB_ASSIGNED]: 'AWB assigned',
  [OPS_STATES.PICKUP_SCHEDULED]: 'Pickup scheduled',
  [OPS_STATES.MANIFEST_READY]: 'Manifest ready',
  [OPS_STATES.LABEL_READY]: 'Label ready',
  [OPS_STATES.IN_TRANSIT]: 'In transit',
  [OPS_STATES.OUT_FOR_DELIVERY]: 'Out for delivery',
  [OPS_STATES.DELIVERED]: 'Delivered',
  [OPS_STATES.RTO]: 'RTO',
  [OPS_STATES.PICKUP_EXCEPTION]: 'Pickup exception',
  [OPS_STATES.PROVIDER_RESET]: 'Shipment reset on Shiprocket',
  [OPS_STATES.CANCELLED]: 'Cancelled',
  [OPS_STATES.PAYMENT_FAILED]: 'Payment failed',
  [OPS_STATES.NEEDS_MANUAL_REVIEW]: 'Needs manual review',
  [OPS_STATES.NONE]: '—',
});

const ACTION_KEYS = Object.freeze({
  accept: 'accept',
  reject: 'reject',
  shipNow: 'shipNow',
  schedulePickup: 'schedulePickup',
  generateManifest: 'generateManifest',
  downloadManifest: 'downloadManifest',
  downloadLabel: 'downloadLabel',
  downloadTaxInvoice: 'downloadTaxInvoice',
  syncShiprocket: 'syncShiprocket',
  refreshTracking: 'refreshTracking',
  retryPickup: 'retryPickup',
  cancelShipment: 'cancelShipment',
  openShiprocketSupport: 'openShiprocketSupport',
  openShiprocket: 'openShiprocket',
  track: 'track',
  openDetail: 'openDetail',
});

const ACTION_LABELS = Object.freeze({
  [ACTION_KEYS.accept]: 'Accept',
  [ACTION_KEYS.reject]: 'Reject',
  [ACTION_KEYS.shipNow]: 'Ship now',
  [ACTION_KEYS.schedulePickup]: 'Schedule pickup',
  [ACTION_KEYS.generateManifest]: 'Generate manifest',
  [ACTION_KEYS.downloadManifest]: 'Download manifest',
  [ACTION_KEYS.downloadLabel]: 'Download label',
  [ACTION_KEYS.downloadTaxInvoice]: 'Tax invoice',
  [ACTION_KEYS.syncShiprocket]: 'Refresh Shiprocket',
  [ACTION_KEYS.refreshTracking]: 'Refresh tracking',
  [ACTION_KEYS.retryPickup]: 'Retry pickup',
  [ACTION_KEYS.cancelShipment]: 'Cancel on Shiprocket',
  [ACTION_KEYS.openShiprocketSupport]: 'Open Shiprocket support',
  [ACTION_KEYS.openShiprocket]: 'Open on Shiprocket',
  [ACTION_KEYS.track]: 'Track',
  [ACTION_KEYS.openDetail]: 'Open order',
});

/** Primary action preference order when multiple capabilities are enabled. */
const PRIMARY_ACTION_ORDER = Object.freeze([
  ACTION_KEYS.accept,
  ACTION_KEYS.retryPickup,
  ACTION_KEYS.shipNow,
  ACTION_KEYS.schedulePickup,
  ACTION_KEYS.generateManifest,
  ACTION_KEYS.downloadManifest,
  ACTION_KEYS.downloadLabel,
  ACTION_KEYS.syncShiprocket,
  ACTION_KEYS.refreshTracking,
  ACTION_KEYS.track,
  ACTION_KEYS.openShiprocketSupport,
  ACTION_KEYS.openShiprocket,
  ACTION_KEYS.downloadTaxInvoice,
  ACTION_KEYS.openDetail,
]);

const TERMINAL_ORDER_STATUSES = Object.freeze(['cancelled', 'payment_failed', 'delivered', 'rto']);

const IN_TRANSIT_ORDER_STATUSES = Object.freeze(['shipped', 'out_for_delivery']);

/** Ops states where normal Step 2–4 fulfillment UI should be hidden. */
const EXCEPTION_OPS_STATES = Object.freeze([
  OPS_STATES.PICKUP_EXCEPTION,
  OPS_STATES.PROVIDER_RESET,
  OPS_STATES.NEEDS_MANUAL_REVIEW,
]);

module.exports = {
  OPS_STATES,
  OPS_STATE_LABELS,
  ACTION_KEYS,
  ACTION_LABELS,
  PRIMARY_ACTION_ORDER,
  TERMINAL_ORDER_STATUSES,
  IN_TRANSIT_ORDER_STATUSES,
  EXCEPTION_OPS_STATES,
};
