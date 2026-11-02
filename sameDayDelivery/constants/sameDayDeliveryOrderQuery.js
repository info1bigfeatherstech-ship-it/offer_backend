'use strict';

/**
 * Isolate same-day orders from standard courier admin buckets.
 * Mirrors self-pickup exclusion — additive, does not rewrite documents.
 */

function isSameDayOrder(order) {
  return String(order?.fulfillmentMode || '').toLowerCase() === 'same_day';
}

function buildSameDayMatch() {
  return { fulfillmentMode: 'same_day' };
}

function buildSameDayExclusion() {
  return {
    $nor: [{ fulfillmentMode: 'same_day' }],
  };
}

function buildSameDayPendingMatch() {
  return {
    fulfillmentMode: 'same_day',
    orderStatus: 'confirmed',
    paymentStatus: { $in: ['paid', 'partially_refunded'] },
  };
}

function buildSameDayShippedMatch() {
  return {
    fulfillmentMode: 'same_day',
    orderStatus: 'shipped',
  };
}

function buildSameDayCancelledMatch() {
  return {
    fulfillmentMode: 'same_day',
    orderStatus: 'cancelled',
  };
}

module.exports = {
  isSameDayOrder,
  buildSameDayMatch,
  buildSameDayExclusion,
  buildSameDayPendingMatch,
  buildSameDayShippedMatch,
  buildSameDayCancelledMatch,
};
