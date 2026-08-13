/**
 * MongoDB helpers for admin RTO tab — bucket is driven by Shiprocket `providerStatus`,
 * not invented sub-statuses. {@link Order#orderStatus} `rto` marks the RTO workflow bucket.
 *
 * Display labels for RTO journeys never show a bare "Delivered" (warehouse reverse-leg).
 * Demotion rto → delivered is owned by {@link repairOrderStatusForFalseRtoLatch}
 * (timeline-positive proof only). Default is RTO-sticky.
 */

const {
  isRtoProviderStatus,
  isNdrOrUndeliveredProviderStatus
} = require('../services/shipmentOps/shiprocketStatusMap');
const {
  canClearFalseRtoLatch,
  resolveRtoDisplayLabel
} = require('../services/shipmentOps/rtoJourneyClassifier');

/** Case-insensitive match for Shiprocket / Shipmozo RTO carrier labels (see isRtoProviderStatus). */
const RTO_PROVIDER_STATUS_REGEX =
  '\\brto\\b|return to origin|returned to origin|return to seller|returned to seller|\\brts\\b';

/**
 * Shiprocket NDR / Undelivered* labels wrongly stored as orderStatus=delivered.
 * Used to exclude from Completed tab until self-heal runs.
 */
const NDR_UNDELIVERED_PROVIDER_STATUS_REGEX =
  '\\bundelivered\\b|\\bndr\\b|delivery failed|failed delivery|not delivered|delivery attempt failed|consignee refused|customer refused|refused by customer|customer not available';

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
 * Exclude legacy mis-bucketed RTO / false-delivered NDR rows from Cancelled / Delivered tabs.
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
      $and: [
        {
          $or: [
            { orderStatus: { $ne: 'delivered' } },
            {
              'shipmentInfo.providerStatus': {
                $not: { $regex: RTO_PROVIDER_STATUS_REGEX, $options: 'i' }
              }
            },
            { 'shipmentInfo.providerStatus': { $in: [null, ''] } }
          ]
        },
        {
          $or: [
            { orderStatus: { $ne: 'delivered' } },
            {
              'shipmentInfo.providerStatus': {
                $not: { $regex: NDR_UNDELIVERED_PROVIDER_STATUS_REGEX, $options: 'i' }
              }
            },
            { 'shipmentInfo.providerStatus': { $in: [null, ''] } }
          ]
        }
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
  try {
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
  } catch {
    return false;
  }
}

/**
 * Self-heal: Shiprocket NDR / Undelivered* but orderStatus wrongly latched as delivered
 * (legacy substring bug: "undelivered" matched /delivered/).
 * @param {import('mongoose').Document|object} order
 * @returns {boolean}
 */
function repairOrderStatusForFalseDeliveredNdr(order) {
  try {
    if (!order || typeof order !== 'object') return false;
    const providerStatus = order.shipmentInfo?.providerStatus;
    if (!isNdrOrUndeliveredProviderStatus(providerStatus)) return false;
    const st = String(order.orderStatus || '').toLowerCase();
    if (st !== 'delivered') return false;
    order.orderStatus = 'shipped';
    if (order.shipmentInfo && typeof order.shipmentInfo === 'object') {
      order.shipmentInfo.deliveredAt = null;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether provider-driven orderStatus may be applied from current state.
 * Allows demotion from false `delivered` when Shiprocket reports NDR / in-transit / OFD / RTO.
 * rto → delivered is blocked unless {@link canClearFalseRtoLatch} proves no courier RTO evidence.
 * @param {string|null|undefined} currentStatus
 * @param {string|null|undefined} mappedStatus
 * @param {string|null|undefined} [providerStatus]
 * @param {import('mongoose').Document|object|null|undefined} [orderContext] merged shipment + returnInfo
 */
function canApplyProviderOrderStatus(currentStatus, mappedStatus, providerStatus, orderContext) {
  try {
    const cur = String(currentStatus || '').toLowerCase();
    const mapped = String(mappedStatus || '').toLowerCase();
    if (!mapped) return false;
    if (mapped === cur) return true;
    if (mapped === 'rto') {
      return ['confirmed', 'processing', 'shipped', 'out_for_delivery', 'delivered', 'cancelled', 'rto'].includes(
        cur
      );
    }
    // Reverse-leg "Delivered" after RTO must never leave the RTO bucket.
    // Only a proven false latch (timeline with zero RTO evidence) may demote.
    if (mapped === 'delivered' && cur === 'rto') {
      const view =
        orderContext && typeof orderContext === 'object'
          ? {
              orderStatus: orderContext.orderStatus || cur,
              shipmentInfo: orderContext.shipmentInfo || { providerStatus },
              returnInfo: orderContext.returnInfo
            }
          : {
              orderStatus: cur,
              shipmentInfo: { providerStatus }
            };
      return canClearFalseRtoLatch(view) === true;
    }
    // Correct false Delivered latch when carrier still shows Undelivered / NDR / OFD / transit.
    if (
      cur === 'delivered' &&
      (mapped === 'shipped' || mapped === 'out_for_delivery') &&
      (isNdrOrUndeliveredProviderStatus(providerStatus) ||
        /out for delivery|\bofd\b|in transit|picked up|dispatched|\bshipped\b/i.test(
          String(providerStatus || '')
        ))
    ) {
      return true;
    }
    const forwardEditable = ['confirmed', 'processing', 'shipped', 'out_for_delivery'];
    return !cur || forwardEditable.includes(cur);
  } catch {
    return false;
  }
}

/**
 * Self-heal: orderStatus latched `rto` but journey is true customer delivery
 * (no RTO in current status, tracking history, or returnInfo).
 * Never moves "RTO Delivered" / reverse-leg Delivered out of RTO.
 * @param {import('mongoose').Document|object} order
 * @returns {boolean}
 */
function repairOrderStatusForFalseRtoLatch(order) {
  try {
    if (!order || typeof order !== 'object') return false;
    if (!canClearFalseRtoLatch(order)) return false;
    order.orderStatus = 'delivered';
    if (order.shipmentInfo && typeof order.shipmentInfo === 'object' && !order.shipmentInfo.deliveredAt) {
      order.shipmentInfo.deliveredAt = new Date();
      if (typeof order.markModified === 'function') {
        order.markModified('shipmentInfo');
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Admin list/detail label — carrier text when in RTO flow.
 * Bare "Delivered" while latched RTO is shown as "RTO Delivered" (warehouse reverse-leg).
 * @param {string|null|undefined} orderStatus
 * @param {string|null|undefined} providerStatus
 * @param {import('mongoose').Document|object|null|undefined} [order]
 */
function fulfillmentLabelForRtoAwareOrder(orderStatus, providerStatus, order) {
  try {
    const st = String(orderStatus || '').toLowerCase();
    const ps = String(providerStatus || '').trim();
    if (st === 'rto' || isRtoProviderStatus(ps)) {
      return resolveRtoDisplayLabel(ps, order || { orderStatus, shipmentInfo: { providerStatus: ps } });
    }
    return null;
  } catch {
    const ps = String(providerStatus || '').trim();
    return ps || 'RTO';
  }
}

module.exports = {
  RTO_PROVIDER_STATUS_REGEX,
  NDR_UNDELIVERED_PROVIDER_STATUS_REGEX,
  buildRtoBucketMatch,
  buildRtoExclusionForNonRtoBucket,
  repairOrderStatusForShiprocketRto,
  repairOrderStatusForFalseDeliveredNdr,
  repairOrderStatusForFalseRtoLatch,
  canApplyProviderOrderStatus,
  fulfillmentLabelForRtoAwareOrder,
  isRtoProviderStatus
};
