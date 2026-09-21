/**
 * Admin / staff roles for order operations.
 * packing_viewer = packing queue from Confirmed through Processing
 * (until courier pickup / In transit) + label download. No write ops.
 */

const PACKING_VIEWER_ROLE = 'packing_viewer';

/** Can open admin order list/detail (incl. packing_viewer). */
const ORDER_READ_ROLES = Object.freeze(['admin', 'order_manager', PACKING_VIEWER_ROLE]);

/** Can mutate fulfillment / accept / cancel / sync (not packing_viewer). */
const ORDER_WRITE_ROLES = Object.freeze(['admin', 'order_manager']);

/**
 * Buckets packing_viewer may browse:
 * - bill_sent = Confirmed
 * - ready_to_ship = processing, label not downloaded (Ship now done)
 * - ready_to_pick = Processing (label/schedule done, awaiting courier pickup)
 */
const PACKING_VIEWER_BUCKETS = Object.freeze([
  'bill_sent',
  'ready_to_ship',
  'ready_to_pick'
]);

function resolveRequestRole(req) {
  return String(req?.user?.role || req?.userRole || req?.userType || '')
    .trim()
    .toLowerCase();
}

function isOrderReadStaffRole(role) {
  return ORDER_READ_ROLES.includes(String(role || '').trim().toLowerCase());
}

function isOrderWriteStaffRole(role) {
  return ORDER_WRITE_ROLES.includes(String(role || '').trim().toLowerCase());
}

function isPackingViewerRole(role) {
  return String(role || '').trim().toLowerCase() === PACKING_VIEWER_ROLE;
}

function isOrderReadStaffRequest(req) {
  return isOrderReadStaffRole(resolveRequestRole(req));
}

function isOrderWriteStaffRequest(req) {
  return isOrderWriteStaffRole(resolveRequestRole(req));
}

function isPackingViewerRequest(req) {
  return isPackingViewerRole(resolveRequestRole(req));
}

/**
 * Confirmed OR any processing (Ready to Ship + Processing / scheduled / labeled).
 * Shipped / in-transit / delivered / RTO excluded (courier already picked up or beyond).
 */
function isPackingViewerListVisibleOrder(orderLike) {
  try {
    const st = String(orderLike?.orderStatus || '')
      .trim()
      .toLowerCase();
    return st === 'confirmed' || st === 'processing';
  } catch (_) {
    return false;
  }
}

/**
 * Detail + label: same window as list (confirmed | processing).
 * Still blocks shipped+.
 */
function isPackingViewerDetailVisibleOrder(orderLike) {
  return isPackingViewerListVisibleOrder(orderLike);
}

/** Mongo match for packing_viewer list / search / summary scope. */
function buildPackingViewerOrderMatch() {
  return {
    orderStatus: { $in: ['confirmed', 'processing'] }
  };
}

/**
 * Normalize bucket for packing_viewer. Invalid / shipped buckets → empty result sentinel.
 * @returns {{ bucket: string|null, empty: boolean }}
 */
function resolvePackingViewerBucket(requestedBucket) {
  const b = String(requestedBucket || '')
    .trim()
    .toLowerCase();
  if (!b || b === 'all') {
    return { bucket: null, empty: false };
  }
  if (PACKING_VIEWER_BUCKETS.includes(b)) {
    return { bucket: b, empty: false };
  }
  return { bucket: b, empty: true };
}

module.exports = {
  PACKING_VIEWER_ROLE,
  ORDER_READ_ROLES,
  ORDER_WRITE_ROLES,
  PACKING_VIEWER_BUCKETS,
  resolveRequestRole,
  isOrderReadStaffRole,
  isOrderWriteStaffRole,
  isPackingViewerRole,
  isOrderReadStaffRequest,
  isOrderWriteStaffRequest,
  isPackingViewerRequest,
  isPackingViewerListVisibleOrder,
  isPackingViewerDetailVisibleOrder,
  buildPackingViewerOrderMatch,
  resolvePackingViewerBucket
};
