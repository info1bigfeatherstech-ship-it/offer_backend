/**
 * Admin order list — courier ops summary + per-row action capabilities.
 * Delegates to shipment ops engine (provider-status aware).
 */

const { buildShipmentOpsView } = require('../services/shipmentOps');
const { ACTION_LABELS } = require('../services/shipmentOps/constants');

/**
 * @param {object} order — plain order object (may include shipmentInfo)
 */
function buildCourierOpsDisplay(order) {
  const view = buildShipmentOpsView(order, {
    fulfillmentPaymentGate: order?.fulfillmentPaymentGate,
    canConfirmForFulfillment: order?.canConfirmForFulfillment,
    source: 'admin_list_courier_ops'
  });
  if (!view) return { line1: '—', line2: null };
  return { line1: view.courierOpsLine1, line2: view.courierOpsLine2 };
}

/**
 * @param {object} row — mapped list row fields
 */
function buildRowActionCapabilities(row) {
  const view = buildShipmentOpsView(row, {
    fulfillmentPaymentGate: row?.fulfillmentPaymentGate,
    canConfirmForFulfillment: row?.canConfirmForFulfillment,
    source: 'admin_list_actions'
  });
  return view?.actionCapabilities || { openDetail: true };
}

/**
 * @param {object} order
 */
function buildListRowFulfillmentUi(order) {
  const view = buildShipmentOpsView(order, {
    fulfillmentPaymentGate: order?.fulfillmentPaymentGate,
    canConfirmForFulfillment: order?.canConfirmForFulfillment,
    source: 'admin_list'
  });
  if (!view) {
    return {
      courierOpsLine1: '—',
      courierOpsLine2: null,
      actionCapabilities: { openDetail: true },
      primaryAction: 'openDetail',
      primaryActionLabel: ACTION_LABELS.openDetail
    };
  }
  return {
    courierOpsLine1: view.courierOpsLine1,
    courierOpsLine2: view.courierOpsLine2,
    actionCapabilities: view.actionCapabilities,
    primaryAction: view.primaryAction,
    primaryActionLabel: view.primaryActionLabel,
    opsState: view.opsState,
    opsStateLabel: view.opsStateLabel,
    blockReasons: view.blockReasons,
    nextStepMessage: view.nextStepMessage,
    riskFlags: view.riskFlags,
    externalLinks: view.externalLinks,
    syncHealth: view.syncHealth
  };
}

/**
 * @param {string} orderStatus
 */
function isPostConfirmOrderStatus(orderStatus) {
  const st = String(orderStatus || '').toLowerCase();
  return st && !['pending', 'cancelled', 'payment_failed'].includes(st);
}

module.exports = {
  buildCourierOpsDisplay,
  buildRowActionCapabilities,
  buildListRowFulfillmentUi,
  isPostConfirmOrderStatus,
  ACTION_LABELS
};
