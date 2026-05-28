/**
 * Evaluate and optionally persist shipment ops snapshot on an order.
 */

const Order = require('../../models/Order');
const { evaluateOrderPaymentForShiprocketFulfillment } = require('../../utils/orderFulfillmentPaymentGate');
const { OPS_STATE_LABELS, ACTION_KEYS } = require('./constants');
const { computeOpsState } = require('./computeOpsState');
const { buildActionPolicy } = require('./actionPolicy');
const {
  buildCourierOpsDisplay,
  buildExternalLinks,
  computeSyncHealth,
} = require('./buildOpsView');

/**
 * @param {import('mongoose').Document|object|null|undefined} orderInput
 * @returns {object|null}
 */
function toPlainOrder(orderInput) {
  if (!orderInput) return null;
  if (typeof orderInput.toObject === 'function') {
    return orderInput.toObject({ virtuals: true });
  }
  return orderInput;
}

/**
 * Build full shipment ops view for list/detail APIs (pure evaluation).
 * @param {import('mongoose').Document|object} orderInput
 * @param {{ source?: string, fulfillmentPaymentGate?: object, canConfirmForFulfillment?: boolean }} [options]
 */
function buildShipmentOpsView(orderInput, options = {}) {
  const order = toPlainOrder(orderInput);
  if (!order) return null;

  const orderStatusLower = String(order.orderStatus || '').toLowerCase();
  const isPending = orderStatusLower === 'pending';
  const fulfillmentPaymentGate =
    options.fulfillmentPaymentGate ?? evaluateOrderPaymentForShiprocketFulfillment(order);
  const canConfirmForFulfillment =
    options.canConfirmForFulfillment ?? (isPending && fulfillmentPaymentGate.ok === true);

  const opsState = computeOpsState(order);
  const policy = buildActionPolicy({
    opsState,
    order,
    fulfillmentPaymentGate,
    canConfirmForFulfillment,
  });
  const courierOps = buildCourierOpsDisplay({ opsState, order });
  const externalLinks = buildExternalLinks(order);

  return {
    opsState,
    opsStateLabel: OPS_STATE_LABELS[opsState] || opsState,
    providerStatusRaw: order.shipmentInfo?.providerStatus || null,
    courierOpsLine1: courierOps.line1,
    courierOpsLine2: courierOps.line2,
    primaryAction: policy.primaryAction,
    primaryActionLabel: policy.primaryActionLabel,
    actionCapabilities: policy.actionCapabilities,
    blockReasons: policy.blockReasons,
    nextStepMessage: policy.nextStepMessage,
    riskFlags: policy.riskFlags,
    externalLinks,
    syncHealth: computeSyncHealth(order),
    lastEvaluatedAt: new Date().toISOString(),
    evaluationSource: options.source || 'evaluate',
    fulfillmentPaymentGate: fulfillmentPaymentGate.ok
      ? { ok: true, reason: fulfillmentPaymentGate.reason }
      : {
          ok: false,
          code: fulfillmentPaymentGate.code,
          message: fulfillmentPaymentGate.message,
        },
  };
}

/**
 * @param {import('mongoose').Document} orderDoc
 * @param {{ source?: string }} [options]
 */
async function evaluateAndPersistShipmentOps(orderDoc, options = {}) {
  if (!orderDoc) return null;
  const view = buildShipmentOpsView(orderDoc, options);
  orderDoc.shipmentOps = view;
  orderDoc.markModified('shipmentOps');
  await orderDoc.save();
  return view;
}

/**
 * @param {string} orderId
 * @param {{ source?: string }} [options]
 */
async function reconcileShipmentOpsByOrderId(orderId, options = {}) {
  const id = String(orderId || '').trim();
  if (!id) {
    return { success: false, code: 'ORDER_ID_REQUIRED', message: 'orderId is required' };
  }
  const order = await Order.findOne({ orderId: id });
  if (!order) {
    return { success: false, code: 'ORDER_NOT_FOUND', message: 'Order not found' };
  }
  const ops = await evaluateAndPersistShipmentOps(order, options);
  return { success: true, ops, order };
}

/**
 * Server-side guard for fulfillment mutations (manifest, label, pickup, etc.).
 * @param {import('mongoose').Document|object} orderInput
 * @param {string} actionKey — ACTION_KEYS value
 */
function assertShipmentOpsAction(orderInput, actionKey) {
  const key = String(actionKey || '').trim();
  if (!key || !Object.values(ACTION_KEYS).includes(key)) {
    return {
      ok: false,
      code: 'INVALID_OPS_ACTION',
      message: 'Invalid shipment ops action key'
    };
  }
  const view = buildShipmentOpsView(orderInput);
  if (!view) {
    return { ok: false, code: 'OPS_EVAL_FAILED', message: 'Could not evaluate shipment ops state' };
  }
  if (view.actionCapabilities?.[key] !== true) {
    return {
      ok: false,
      code: 'SHIPMENT_OPS_ACTION_BLOCKED',
      message:
        view.blockReasons?.[key] ||
        `Action is not allowed while shipment is in state: ${view.opsStateLabel || view.opsState}`,
      opsState: view.opsState,
      blockReasons: view.blockReasons || {}
    };
  }
  return { ok: true, view };
}

module.exports = {
  buildShipmentOpsView,
  evaluateAndPersistShipmentOps,
  reconcileShipmentOpsByOrderId,
  assertShipmentOpsAction,
  toPlainOrder,
};
