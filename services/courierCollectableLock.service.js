/**
 * Courier collectable COD lock — amount sent to Shipmozo/Shiprocket at push time.
 *
 * After lock: customer UI + collectable labels must show this amount.
 * Ship Now / OOS freight settlement may still update internal balanceDueInr /
 * deliveryCharges for admin accounting, but must not change customer-facing
 * collectable or the shipping line shown to the customer.
 */
const { roundMoney2 } = require('./checkoutComputation.service');

/**
 * Live COD that would be sent to courier right now (pre-lock math).
 * @param {object} order
 * @returns {{ useCodAtDoor: boolean, collectableInr: number }}
 */
function computeLiveCourierCollectable(order) {
  try {
    const payMethod = String(order?.paymentInfo?.method || order?.paymentMethod || '')
      .toLowerCase()
      .trim();
    const balanceViaCod =
      String(order?.paymentInfo?.balanceCollectionMethod || '').toLowerCase() === 'cod';
    const totalInr = roundMoney2(Number(order?.totalAmount) || 0);
    const paidInr = roundMoney2(Number(order?.amountPaidInr) || 0);
    let balanceDue = roundMoney2(Math.max(0, Number(order?.balanceDueInr) || 0));
    if (!(balanceDue > 0.005) && paidInr > 0.005 && totalInr > 0.005) {
      balanceDue = roundMoney2(Math.max(0, totalInr - paidInr));
    }
    const unpaidInr = roundMoney2(Math.max(0, totalInr - paidInr));
    if (balanceDue > unpaidInr + 0.005) {
      balanceDue = unpaidInr;
    }
    const useCodAtDoor = payMethod === 'cod' || (balanceViaCod && balanceDue > 0.005);
    if (!useCodAtDoor) {
      return { useCodAtDoor: false, collectableInr: 0 };
    }
    const collectableInr =
      payMethod === 'cod' ? totalInr : roundMoney2(Math.max(0, balanceDue));
    return { useCodAtDoor: true, collectableInr };
  } catch (_) {
    return { useCodAtDoor: false, collectableInr: 0 };
  }
}

function hasCourierCollectableLock(order) {
  try {
    const v = order?.shipmentInfo?.courierCollectableInr;
    return v != null && Number.isFinite(Number(v));
  } catch (_) {
    return false;
  }
}

function getLockedCourierCollectableInr(order) {
  try {
    if (!hasCourierCollectableLock(order)) return null;
    return roundMoney2(Math.max(0, Number(order.shipmentInfo.courierCollectableInr) || 0));
  } catch (_) {
    return null;
  }
}

function getCustomerFacingCollectableInr(order) {
  try {
    const locked = getLockedCourierCollectableInr(order);
    if (locked != null) return locked;
    return computeLiveCourierCollectable(order).collectableInr;
  } catch (_) {
    return 0;
  }
}

/**
 * Shipping shown to customer / on our collectable label after push.
 * Prefer frozen push-time delivery; never follow Ship Now updates.
 */
function getCustomerFacingDeliveryInr(order) {
  try {
    const frozen = order?.shipmentInfo?.courierDeliveryInr;
    if (frozen != null && Number.isFinite(Number(frozen))) {
      return roundMoney2(Math.max(0, Number(frozen)));
    }
    if (hasCourierCollectableLock(order)) {
      const held = order?.paymentInfo?.oosShippingSettlement?.heldDeliveryCharges;
      if (held != null && Number.isFinite(Number(held))) {
        return roundMoney2(Math.max(0, Number(held)));
      }
    }
    return roundMoney2(Math.max(0, Number(order?.deliveryCharges) || 0));
  } catch (_) {
    return roundMoney2(Math.max(0, Number(order?.deliveryCharges) || 0));
  }
}

/**
 * Order total line for customer UI after push (aligned with frozen shipping).
 */
function getCustomerFacingOrderTotalInr(order) {
  try {
    const frozen = order?.shipmentInfo?.courierFacingTotalInr;
    if (frozen != null && Number.isFinite(Number(frozen))) {
      return roundMoney2(Math.max(0, Number(frozen)));
    }
    if (hasCourierCollectableLock(order)) {
      const sub = roundMoney2(Number(order?.subtotal) || 0);
      const tax = roundMoney2(Number(order?.tax) || 0);
      const disc = roundMoney2(Number(order?.discount) || 0);
      const del = getCustomerFacingDeliveryInr(order);
      return roundMoney2(Math.max(0, sub + del + tax - disc));
    }
    return roundMoney2(Math.max(0, Number(order?.totalAmount) || 0));
  } catch (_) {
    return roundMoney2(Math.max(0, Number(order?.totalAmount) || 0));
  }
}

function applyCourierCollectableLock(order, opts = {}) {
  try {
    if (!order || typeof order !== 'object') {
      return {
        locked: false,
        amountInr: null,
        deliveryInr: null,
        totalInr: null,
        alreadyLocked: false
      };
    }
    if (!order.shipmentInfo || typeof order.shipmentInfo !== 'object') {
      order.shipmentInfo = {};
    }
    if (hasCourierCollectableLock(order)) {
      if (
        !(
          order.shipmentInfo.courierDeliveryInr != null &&
          Number.isFinite(Number(order.shipmentInfo.courierDeliveryInr))
        )
      ) {
        const d =
          opts.deliveryInr != null && opts.deliveryInr !== ''
            ? Number(opts.deliveryInr)
            : Number(order.deliveryCharges) || 0;
        if (Number.isFinite(d) && d >= 0) {
          order.shipmentInfo.courierDeliveryInr = roundMoney2(d);
        }
      }
      if (
        !(
          order.shipmentInfo.courierFacingTotalInr != null &&
          Number.isFinite(Number(order.shipmentInfo.courierFacingTotalInr))
        )
      ) {
        const t =
          opts.totalInr != null && opts.totalInr !== ''
            ? Number(opts.totalInr)
            : Number(order.totalAmount) || 0;
        if (Number.isFinite(t) && t >= 0) {
          order.shipmentInfo.courierFacingTotalInr = roundMoney2(t);
        }
      }
      if (typeof order.markModified === 'function') {
        order.markModified('shipmentInfo');
      }
      return {
        locked: false,
        amountInr: getLockedCourierCollectableInr(order),
        deliveryInr: getCustomerFacingDeliveryInr(order),
        totalInr: getCustomerFacingOrderTotalInr(order),
        alreadyLocked: true
      };
    }

    let amount =
      opts.amountInr != null && opts.amountInr !== ''
        ? Number(opts.amountInr)
        : computeLiveCourierCollectable(order).collectableInr;
    if (!Number.isFinite(amount) || amount < 0) amount = 0;
    amount = roundMoney2(amount);

    let deliveryInr =
      opts.deliveryInr != null && opts.deliveryInr !== ''
        ? Number(opts.deliveryInr)
        : Number(order.deliveryCharges) || 0;
    if (!Number.isFinite(deliveryInr) || deliveryInr < 0) deliveryInr = 0;
    deliveryInr = roundMoney2(deliveryInr);

    let totalInr =
      opts.totalInr != null && opts.totalInr !== ''
        ? Number(opts.totalInr)
        : Number(order.totalAmount) || 0;
    if (!Number.isFinite(totalInr) || totalInr < 0) totalInr = 0;
    totalInr = roundMoney2(totalInr);

    order.shipmentInfo.courierCollectableInr = amount;
    order.shipmentInfo.courierDeliveryInr = deliveryInr;
    order.shipmentInfo.courierFacingTotalInr = totalInr;
    order.shipmentInfo.codLockedAt = new Date();
    order.shipmentInfo.codLockSource = String(opts.source || 'courier_push').slice(0, 64);

    if (typeof order.markModified === 'function') {
      order.markModified('shipmentInfo');
    }

    return {
      locked: true,
      amountInr: amount,
      deliveryInr,
      totalInr,
      alreadyLocked: false
    };
  } catch (_) {
    return {
      locked: false,
      amountInr: null,
      deliveryInr: null,
      totalInr: null,
      alreadyLocked: false
    };
  }
}

function resolveLockAmountFromShipmentResult(order, shipmentResult) {
  try {
    const fromResult =
      shipmentResult?.codCollectInr ??
      shipmentResult?.cod_amount ??
      shipmentResult?.adhocPayloadDebug?.cod_amount ??
      null;
    if (fromResult != null && fromResult !== '' && Number.isFinite(Number(fromResult))) {
      return roundMoney2(Math.max(0, Number(fromResult)));
    }
    return computeLiveCourierCollectable(order).collectableInr;
  } catch (_) {
    return computeLiveCourierCollectable(order).collectableInr;
  }
}

function buildCourierLockShipmentPayloadFields(order, shipmentResult, source) {
  try {
    return {
      courierCollectableInr: resolveLockAmountFromShipmentResult(order, shipmentResult),
      courierDeliveryInr: roundMoney2(Math.max(0, Number(order?.deliveryCharges) || 0)),
      courierFacingTotalInr: roundMoney2(Math.max(0, Number(order?.totalAmount) || 0)),
      codLockSource: String(source || 'courier_push').slice(0, 64)
    };
  } catch (_) {
    return {
      courierCollectableInr: 0,
      courierDeliveryInr: 0,
      courierFacingTotalInr: 0,
      codLockSource: String(source || 'courier_push').slice(0, 64)
    };
  }
}

module.exports = {
  computeLiveCourierCollectable,
  hasCourierCollectableLock,
  getLockedCourierCollectableInr,
  getCustomerFacingCollectableInr,
  getCustomerFacingDeliveryInr,
  getCustomerFacingOrderTotalInr,
  applyCourierCollectableLock,
  resolveLockAmountFromShipmentResult,
  buildCourierLockShipmentPayloadFields
};
