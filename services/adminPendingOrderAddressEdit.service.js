/**
 * Admin pending-order delivery address edit (before accept / Shiprocket create).
 *
 * Safety:
 * - Only `pending` orders without Shiprocket shipment refs
 * - Phone is frozen from existing addressSnapshot (identity / courier contact)
 * - fullName is editable (capped by addressValidation / Shipmozo 50-char limit)
 * - Name-only patches update snapshot (and optional saved Address) without
 *   shipping reprice, money mutation, refunds, or amendment notifications
 * - Street/location patches re-quote shipping (never increases customer delivery);
 *   refunds excess when fully paid
 */

const Order = require('../models/Order');
const Address = require('../models/Address');
const logger = require('../utils/logger');
const {
  validatePhysicalAddressForSave,
  MAX_FULL_NAME_LEN
} = require('../utils/addressValidation');
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
  'fullName',
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

/** Phone stays frozen; fullName may be corrected by admin before accept. */
const FROZEN_CONTACT_FIELDS = Object.freeze(['phone']);

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

/** True when the only editable key present is fullName (shipping-irrelevant). */
function isNameOnlyAddressPatch(patch) {
  if (!patch || typeof patch !== 'object') return false;
  const keys = Object.keys(patch);
  return keys.length === 1 && keys[0] === 'fullName';
}

function normalizeRecipientFullName(raw) {
  const fullName = raw == null ? '' : String(raw).trim();
  if (!fullName) {
    throw createEditError(400, 'ADDRESS_VALIDATION_FAILED', 'Full name is required.', {
      errors: [{ field: 'fullName', code: 'REQUIRED', message: 'Full name is required.' }]
    });
  }
  if (fullName.length < 2) {
    throw createEditError(
      400,
      'ADDRESS_VALIDATION_FAILED',
      'Full name must be at least 2 characters.',
      {
        errors: [
          {
            field: 'fullName',
            code: 'FULL_NAME_TOO_SHORT',
            message: 'Full name must be at least 2 characters.'
          }
        ]
      }
    );
  }
  if (fullName.length > MAX_FULL_NAME_LEN) {
    throw createEditError(
      400,
      'ADDRESS_VALIDATION_FAILED',
      `Full name is too long (max ${MAX_FULL_NAME_LEN} characters). Enter only the recipient's name — put house, street, landmark, and phone in their own fields.`,
      {
        errors: [
          {
            field: 'fullName',
            code: 'FULL_NAME_TOO_LONG',
            message: `Full name is too long (max ${MAX_FULL_NAME_LEN} characters). Enter only the recipient's name — put house, street, landmark, and phone in their own fields.`
          }
        ]
      }
    );
  }
  return fullName;
}

function buildMergedAddressCandidate(snapshot, patch) {
  const snap = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const next = { ...snap };
  for (const key of EDITABLE_ADDRESS_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      next[key] = patch[key];
    }
  }
  // Always keep original phone — never accept phone from client patch.
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

async function maybeUpdateSavedAddressFields({
  order,
  orderId,
  alsoUpdateSavedAddress,
  fields
}) {
  if (!alsoUpdateSavedAddress) return false;
  try {
    const addressId = order.address;
    if (!addressId) return false;
    const saved = await Address.findById(addressId);
    if (saved && String(saved.userId) === String(order.userId)) {
      for (const [key, value] of Object.entries(fields || {})) {
        saved[key] = value;
      }
      await saved.save();
      return true;
    }
    if (saved) {
      logger.warn('[adminPendingAddressEdit] skipped Address book update — userId mismatch', {
        orderId,
        orderUserId: String(order.userId),
        addressUserId: String(saved.userId)
      });
    }
  } catch (err) {
    logger.error('[adminPendingAddressEdit] Address book update failed', {
      orderId,
      message: err.message
    });
  }
  return false;
}

/**
 * Name-only path: mutate addressSnapshot.fullName only.
 * No shipping reprice, money fields, refunds, or amendment push notifications.
 */
async function previewOrApplyNameOnlyEdit({
  order,
  orderId,
  beforeSnap,
  beforeMoney,
  nextFullName,
  alsoUpdateSavedAddress,
  commit
}) {
  const nextSnapshot = {
    ...beforeSnap,
    fullName: nextFullName
  };

  const localQuality = computeLocalAddressQuality(nextSnapshot);
  const shippingSnapshot =
    order.shippingSnapshot && typeof order.shippingSnapshot === 'object'
      ? order.shippingSnapshot
      : {};

  const preview = {
    orderId,
    nameOnly: true,
    before: {
      ...beforeMoney,
      address: formatAddressLines(beforeSnap),
      contact: {
        fullName: beforeSnap.fullName || null,
        phone: beforeSnap.phone || null
      },
      contactFrozen: {
        phone: beforeSnap.phone || null
      }
    },
    after: {
      subtotal: beforeMoney.subtotal,
      deliveryCharges: beforeMoney.deliveryCharges,
      tax: beforeMoney.tax,
      discount: beforeMoney.discount,
      totalAmount: beforeMoney.totalAmount,
      amountPaidInr: beforeMoney.amountPaidInr,
      balanceDueInr: beforeMoney.balanceDueInr,
      paymentStatus: beforeMoney.paymentStatus,
      address: formatAddressLines(nextSnapshot),
      addressSnapshot: nextSnapshot,
      contact: {
        fullName: nextSnapshot.fullName || null,
        phone: nextSnapshot.phone || null
      },
      contactFrozen: {
        phone: nextSnapshot.phone || null
      },
      localAddressQuality: localQuality
    },
    refundInr: 0,
    shipping: {
      oldDelivery: beforeMoney.deliveryCharges,
      quotedDelivery: beforeMoney.deliveryCharges,
      customerDelivery: beforeMoney.deliveryCharges,
      shippingIncreasedAbsorbed: false,
      courierName: shippingSnapshot.courierName || null,
      courierCompanyId: shippingSnapshot.courierCompanyId || null,
      estimatedDays: shippingSnapshot.estimatedDays || null
    },
    alsoUpdateSavedAddress: Boolean(alsoUpdateSavedAddress),
    commit: false
  };

  if (!commit) {
    return { success: true, preview };
  }

  order.addressSnapshot = nextSnapshot;
  order.markModified('addressSnapshot');

  order.customerNotes = Array.isArray(order.customerNotes) ? order.customerNotes : [];
  order.customerNotes.push({
    kind: 'recipient_name_updated',
    message: 'Recipient name was corrected by our team for accurate courier labeling.',
    createdAt: new Date(),
    metadata: {
      beforeFullName: beforeSnap.fullName || null,
      afterFullName: nextFullName,
      nameOnly: true
    }
  });
  order.markModified('customerNotes');

  await order.save();

  const savedAddressUpdated = await maybeUpdateSavedAddressFields({
    order,
    orderId,
    alsoUpdateSavedAddress,
    fields: { fullName: nextFullName }
  });

  return {
    success: true,
    orderId,
    nameOnly: true,
    refundInr: 0,
    refundWarning: null,
    shipping: preview.shipping,
    addressSnapshot: nextSnapshot,
    localAddressQuality: localQuality,
    savedAddressUpdated,
    paymentStatus: order.paymentStatus,
    totalAmount: order.totalAmount,
    deliveryCharges: order.deliveryCharges
  };
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

  const { mergeOrderScopeFilter } = require('../utils/adminOrderScope');
  const order = await Order.findOne(mergeOrderScopeFilter({ orderId }, opts.scopeMatch || null));
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

  // ——— Name-only: no shipping / money / refund side effects ———
  if (isNameOnlyAddressPatch(patch)) {
    const nextFullName = normalizeRecipientFullName(patch.fullName);
    if (String(beforeSnap.fullName || '').trim() === nextFullName) {
      throw createEditError(400, 'ADDRESS_PATCH_REQUIRED', 'Recipient name is unchanged.');
    }
    return previewOrApplyNameOnlyEdit({
      order,
      orderId,
      beforeSnap,
      beforeMoney,
      nextFullName,
      alsoUpdateSavedAddress: Boolean(opts.alsoUpdateSavedAddress),
      commit: Boolean(opts.commit)
    });
  }

  const mergedRaw = buildMergedAddressCandidate(beforeSnap, patch);
  const validated = validatePhysicalAddressForSave({
    ...mergedRaw,
    // Phone always from existing snapshot (never from admin patch).
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
    nameOnly: false,
    before: {
      ...beforeMoney,
      address: formatAddressLines(beforeSnap),
      contact: {
        fullName: beforeSnap.fullName || null,
        phone: beforeSnap.phone || null
      },
      // Back-compat for older clients; phone is the only frozen contact field.
      contactFrozen: {
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
      contact: {
        fullName: nextSnapshot.fullName || null,
        phone: nextSnapshot.phone || null
      },
      contactFrozen: {
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

  // ——— Commit (street / location change) ———
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

  const savedFields = {};
  for (const key of EDITABLE_ADDRESS_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(validated.data, key)) {
      savedFields[key] = validated.data[key];
    }
  }
  const savedAddressUpdated = await maybeUpdateSavedAddressFields({
    order,
    orderId,
    alsoUpdateSavedAddress: Boolean(opts.alsoUpdateSavedAddress),
    fields: savedFields
  });

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
    nameOnly: false,
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
  buildMergedAddressCandidate,
  isNameOnlyAddressPatch,
  normalizeRecipientFullName
};
