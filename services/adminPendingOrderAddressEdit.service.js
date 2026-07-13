/**
 * Admin pending-order delivery address edit (before accept / Shiprocket create).
 *
 * Safety:
 * - Only `pending` orders without Shiprocket shipment refs
 * - Name + phone are frozen from existing addressSnapshot
 * - Updates order.addressSnapshot for THIS order only
 * - Optionally updates linked Address doc only when it belongs to the same order.userId
 * - Re-quotes shipping (never increases customer delivery); refunds excess when fully paid
 */

const Order = require('../models/Order');
const Address = require('../models/Address');
const logger = require('../utils/logger');
const { roundMoney2 } = require('./checkoutComputation.service');
const { validatePhysicalAddressForSave } = require('../utils/addressValidation');
const { computeLocalAddressQuality } = require('./addressIntelligence.service');
const {
  assertEditablePendingOrder,
  createEditError,
  repriceShippingForItems,
  settleFinancials,
  attemptAmendmentRefund,
  snapshotMoney
} = require('./adminPendingOrderEdit.service');
const { notifyOrderAmended } = require('./orderAmendmentNotification.service');

const EDITABLE_ADDRESS_FIELDS = Object.freeze([
  'houseNumber',
  'building',
  'floor',
  'area',
  'landmark',
  'addressLine1',
  'addressLine2',
  'city',
  'state',
  'postalCode',
  'country'
]);

const FROZEN_CONTACT_FIELDS = Object.freeze(['fullName', 'phone']);

function pickEditableAddressPatch(body) {
  const src = body && typeof body === 'object' ? body : {};
  const patch = {};
  for (const key of EDITABLE_ADDRESS_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(src, key)) {
      patch[key] = src[key];
    }
  }
  return patch;
}

function buildMergedAddressCandidate(snapshot, patch) {
  const snap = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const next = { ...snap };
  for (const key of EDITABLE_ADDRESS_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      next[key] = patch[key];
    }
  }
  next.fullName = snap.fullName;
  next.phone = snap.phone;
  return next;
}

function formatAddressLines(addr) {
  return [
    addr.houseNumber,
    addr.building,
    addr.floor,
    addr.addressLine1,
    addr.addressLine2,
    addr.area,
    addr.landmark,
    addr.city,
    addr.state,
    addr.postalCode,
    addr.country
  ]
    .filter(Boolean)
    .join(', ');
}

/**
 * @param {{
 *   orderId: string,
 *   addressPatch: object,
 *   commit: boolean,
 *   alsoUpdateSavedAddress?: boolean,
 *   adminUserId?: string|null
 * }} opts
 */
async function previewOrApplyPendingAddressEdit(opts) {
  const orderId = String(opts.orderId || '').trim();
  if (!orderId) {
    throw createEditError(400, 'ORDER_ID_REQUIRED', 'orderId is required');
  }

  const order = await Order.findOne({ orderId });
  assertEditablePendingOrder(order);

  const patch = pickEditableAddressPatch(opts.addressPatch);
  if (!Object.keys(patch).length) {
    throw createEditError(400, 'ADDRESS_PATCH_REQUIRED', 'Provide at least one editable address field.');
  }

  const beforeSnap =
    order.addressSnapshot && typeof order.addressSnapshot === 'object'
      ? { ...order.addressSnapshot }
      : {};
  const beforeMoney = snapshotMoney(order);

  const mergedRaw = buildMergedAddressCandidate(beforeSnap, patch);
  const validated = validatePhysicalAddressForSave({
    ...mergedRaw,
    fullName: beforeSnap.fullName,
    phone: beforeSnap.phone
  });
  if (!validated.ok) {
    throw createEditError(400, validated.code || 'ADDRESS_VALIDATION_FAILED', validated.message, {
      errors: validated.errors
    });
  }

  const nextSnapshot = {
    ...beforeSnap,
    ...validated.data,
    fullName: beforeSnap.fullName,
    phone: String(beforeSnap.phone || '').replace(/\D/g, '').slice(-10) || beforeSnap.phone
  };

  // Reprice against proposed snapshot without persisting yet
  const previousSnapshot = order.addressSnapshot;
  order.addressSnapshot = nextSnapshot;
  let priced;
  try {
    priced = await repriceShippingForItems(order, order.items || []);
  } finally {
    order.addressSnapshot = previousSnapshot;
  }

  const settlement = settleFinancials(order, priced.totalAmount);
  const localQuality = computeLocalAddressQuality(nextSnapshot);

  const preview = {
    orderId,
    before: {
      ...beforeMoney,
      address: formatAddressLines(beforeSnap),
      contactFrozen: {
        fullName: beforeSnap.fullName || null,
        phone: beforeSnap.phone || null
      }
    },
    after: {
      subtotal: priced.subtotal,
      deliveryCharges: priced.customerDelivery,
      tax: priced.tax,
      discount: priced.discount,
      totalAmount: priced.totalAmount,
      amountPaidInr: settlement.amountPaidInr,
      balanceDueInr: settlement.balanceDueInr,
      paymentStatus: settlement.paymentStatus,
      address: formatAddressLines(nextSnapshot),
      addressSnapshot: nextSnapshot,
      contactFrozen: {
        fullName: nextSnapshot.fullName || null,
        phone: nextSnapshot.phone || null
      },
      localAddressQuality: localQuality
    },
    refundInr: settlement.refundInr,
    shipping: {
      oldDelivery: priced.oldDelivery,
      quotedDelivery: priced.quotedDelivery,
      customerDelivery: priced.customerDelivery,
      shippingIncreasedAbsorbed: priced.shippingIncreasedAbsorbed,
      courierName: priced.shippingSnapshot.courierName,
      courierCompanyId: priced.shippingSnapshot.courierCompanyId,
      estimatedDays: priced.shippingSnapshot.estimatedDays
    },
    alsoUpdateSavedAddress: Boolean(opts.alsoUpdateSavedAddress),
    commit: false
  };

  if (!opts.commit) {
    return { success: true, preview };
  }

  // ——— Commit ———
  order.addressSnapshot = nextSnapshot;
  order.markModified('addressSnapshot');
  order.subtotal = priced.subtotal;
  order.deliveryCharges = priced.customerDelivery;
  order.tax = priced.tax;
  order.discount = priced.discount;
  order.totalAmount = priced.totalAmount;
  order.shippingSnapshot = priced.shippingSnapshot;
  order.shippingWeightSnapshot = priced.weightSnapshot;
  order.markModified('shippingSnapshot');
  order.markModified('shippingWeightSnapshot');

  const priorPaymentStatus = order.paymentStatus;
  const refundOutcome = await attemptAmendmentRefund(
    order,
    settlement.refundInr,
    `Address update on order ${orderId}`
  );

  if (settlement.refundInr > 0.005 && refundOutcome.warning) {
    order.paymentStatus = priorPaymentStatus === 'partially_paid' ? 'partially_paid' : 'paid';
    order.paymentInfo = order.paymentInfo || {};
    order.paymentInfo.amendmentRefundFailureReason = refundOutcome.warning;
    order.markModified('paymentInfo');
  } else if (settlement.refundInr > 0.005 && refundOutcome.refund) {
    order.amountPaidInr = settlement.amountPaidInr;
    order.balanceDueInr = 0;
    order.paymentStatus = 'paid';
  } else {
    order.amountPaidInr = settlement.amountPaidInr;
    order.balanceDueInr = settlement.balanceDueInr;
    order.paymentStatus = settlement.paymentStatus;
  }

  const noteMessage =
    settlement.refundInr > 0.005
      ? `Your delivery address was updated by our team for accurate shipping. A refund of ₹${settlement.refundInr.toFixed(2)} was processed for any reduced charges.`
      : 'Your delivery address was updated by our team for accurate shipping.';

  order.customerNotes = Array.isArray(order.customerNotes) ? order.customerNotes : [];
  order.customerNotes.push({
    kind: 'address_updated',
    message: noteMessage,
    createdAt: new Date(),
    metadata: {
      refundInr: settlement.refundInr,
      shipping: preview.shipping
    }
  });
  order.markModified('customerNotes');

  await order.save();

  let savedAddressUpdated = false;
  if (opts.alsoUpdateSavedAddress) {
    try {
      const addressId = order.address;
      if (addressId) {
        const saved = await Address.findById(addressId);
        if (saved && String(saved.userId) === String(order.userId)) {
          for (const key of EDITABLE_ADDRESS_FIELDS) {
            if (Object.prototype.hasOwnProperty.call(validated.data, key)) {
              saved[key] = validated.data[key];
            }
          }
          await saved.save();
          savedAddressUpdated = true;
        } else if (saved) {
          logger.warn('[adminPendingAddressEdit] skipped Address book update — userId mismatch', {
            orderId,
            orderUserId: String(order.userId),
            addressUserId: String(saved.userId)
          });
        }
      }
    } catch (err) {
      logger.error('[adminPendingAddressEdit] Address book update failed', {
        orderId,
        message: err.message
      });
    }
  }

  try {
    await notifyOrderAmended(order, noteMessage, {
      refundInr: settlement.refundInr,
      newTotal: order.totalAmount,
      cancelledEmpty: false
    });
  } catch (notifyErr) {
    logger.warn('[adminPendingAddressEdit] notify failed', { message: notifyErr.message });
  }

  return {
    success: true,
    orderId,
    refundInr: settlement.refundInr,
    refundWarning: refundOutcome.warning,
    shipping: preview.shipping,
    addressSnapshot: nextSnapshot,
    localAddressQuality: localQuality,
    savedAddressUpdated,
    paymentStatus: order.paymentStatus,
    totalAmount: order.totalAmount,
    deliveryCharges: order.deliveryCharges
  };
}

module.exports = {
  EDITABLE_ADDRESS_FIELDS,
  FROZEN_CONTACT_FIELDS,
  previewOrApplyPendingAddressEdit,
  pickEditableAddressPatch,
  buildMergedAddressCandidate
};
