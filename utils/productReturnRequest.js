/**
 * Admin Returns & Refunds tab must only show customer product-return requests
 * (delivered → Raise Return Request), not cancel / amendment / RTO refund rows that
 * also stamp `returnInfo.requestedAt`.
 */

const PRODUCT_RETURN_REASON_TYPES = Object.freeze(['damaged', 'wrong_item']);

/**
 * True when this order is a post-delivery customer return request.
 * @param {object|null|undefined} order
 * @returns {boolean}
 */
function isCustomerProductReturnRequest(order) {
  if (!order) return false;
  const ri = order.returnInfo || {};
  if (!ri.requestedAt) return false;

  const ctx = String(ri.refundContext || '')
    .trim()
    .toLowerCase();
  if (ctx === 'cancellation') return false;
  if (ctx === 'product_return') return true;

  // Legacy rows before refundContext was stamped on createReturnRequest.
  const reason = String(ri.reasonType || '')
    .trim()
    .toLowerCase();
  return PRODUCT_RETURN_REASON_TYPES.includes(reason);
}

/**
 * Mongo match fragment for admin return list / scoped lookups.
 * Always AND with storefront scope via mergeAdminOrderFilter.
 * @returns {import('mongoose').FilterQuery<any>}
 */
function buildAdminProductReturnRequestMatch() {
  return {
    'returnInfo.requestedAt': { $ne: null },
    $or: [
      { 'returnInfo.refundContext': 'product_return' },
      {
        'returnInfo.reasonType': { $in: [...PRODUCT_RETURN_REASON_TYPES] },
        $or: [
          { 'returnInfo.refundContext': null },
          { 'returnInfo.refundContext': { $exists: false } },
          { 'returnInfo.refundContext': '' }
        ]
      }
    ]
  };
}

module.exports = {
  PRODUCT_RETURN_REASON_TYPES,
  isCustomerProductReturnRequest,
  buildAdminProductReturnRequestMatch
};
