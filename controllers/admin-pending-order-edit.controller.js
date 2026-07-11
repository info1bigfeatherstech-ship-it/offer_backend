/**
 * Admin pending-order item edit (preview + commit) before accept / Shiprocket.
 */
const {
  previewOrApplyPendingOrderEdit,
  createEditError
} = require('../services/adminPendingOrderEdit.service');
const logger = require('../utils/logger');

function sendError(res, err, fallbackMessage) {
  const status = Number(err?.statusCode) || 500;
  const code = err?.code || 'PENDING_ORDER_EDIT_FAILED';
  const message = err?.message || fallbackMessage || 'Could not edit pending order';
  if (status >= 500) {
    logger.error('[adminPendingOrderEdit]', { code, message, stack: err?.stack });
  }
  return res.status(status).json({
    success: false,
    code,
    message,
    details: err?.details || undefined
  });
}

/**
 * POST /api/orders/admin/items/:orderId/edit-pending/preview
 * Body: { itemUpdates: [{ productId, variantId, quantity }] }
 */
exports.previewPendingOrderEdit = async (req, res) => {
  try {
    const orderId = req.params.orderId;
    const itemUpdates = req.body?.itemUpdates;
    const result = await previewOrApplyPendingOrderEdit({
      orderId,
      itemUpdates,
      commit: false,
      adminUserId: req.user?.id || req.user?._id || null
    });
    return res.json({
      success: true,
      message: 'Preview calculated',
      data: result.preview
    });
  } catch (err) {
    if (!err.statusCode) {
      return sendError(res, createEditError(500, 'PENDING_ORDER_EDIT_FAILED', err.message), err.message);
    }
    return sendError(res, err, 'Could not preview pending order edit');
  }
};

/**
 * POST /api/orders/admin/items/:orderId/edit-pending
 * Body: { itemUpdates: [{ productId, variantId, quantity }] }
 */
exports.applyPendingOrderEdit = async (req, res) => {
  try {
    const orderId = req.params.orderId;
    const itemUpdates = req.body?.itemUpdates;
    const result = await previewOrApplyPendingOrderEdit({
      orderId,
      itemUpdates,
      commit: true,
      adminUserId: req.user?.id || req.user?._id || null
    });
    return res.json({
      success: true,
      message: result.cancelledEmpty
        ? 'Order cancelled — no items remaining. Refund processed where applicable.'
        : result.refundInr > 0
          ? 'Order updated and refund initiated where applicable.'
          : 'Order updated successfully.',
      data: result
    });
  } catch (err) {
    if (!err.statusCode) {
      return sendError(res, createEditError(500, 'PENDING_ORDER_EDIT_FAILED', err.message), err.message);
    }
    return sendError(res, err, 'Could not apply pending order edit');
  }
};
