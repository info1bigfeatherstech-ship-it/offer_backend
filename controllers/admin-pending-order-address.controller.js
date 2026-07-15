/**
 * Admin address intelligence + pending address edit controllers.
 */
const { getAddressIntelligenceForOrder } = require('../services/addressIntelligence.service');
const {
  previewOrApplyPendingAddressEdit,
  EDITABLE_ADDRESS_FIELDS
} = require('../services/adminPendingOrderAddressEdit.service');
const { createEditError } = require('../services/adminPendingOrderEdit.service');
const { getAdminOrderMatch, mergeOrderScopeFilter } = require('../utils/adminOrderScope');
const Order = require('../models/Order');
const logger = require('../utils/logger');

function sendError(res, err, fallbackMessage) {
  const status = Number(err?.statusCode) || 500;
  const code = err?.code || 'ADDRESS_INTEL_FAILED';
  const message = err?.message || fallbackMessage || 'Request failed';
  if (status >= 500) {
    logger.error('[adminAddressIntelligence]', { code, message, stack: err?.stack });
  }
  return res.status(status).json({
    success: false,
    code,
    message,
    details: err?.details || undefined
  });
}

/**
 * GET /api/orders/admin/items/:orderId/address-intelligence
 * Query: refresh=1 to force Shiprocket show refresh when SR order exists.
 */
exports.getAddressIntelligence = async (req, res) => {
  try {
    const orderId = req.params.orderId;
    const scopeMatch = getAdminOrderMatch(req);
    const scoped = await Order.findOne(mergeOrderScopeFilter({ orderId }, scopeMatch))
      .select('_id orderId')
      .lean();
    if (!scoped) {
      return sendError(
        res,
        createEditError(404, 'ORDER_NOT_FOUND', 'Order not found'),
        'Order not found'
      );
    }
    const refresh = String(req.query.refresh || '') === '1' || String(req.query.refresh || '').toLowerCase() === 'true';
    const data = await getAddressIntelligenceForOrder(orderId, { refreshFromShiprocket: refresh });
    return res.json({ success: true, data });
  } catch (err) {
    if (!err.statusCode) {
      return sendError(res, createEditError(500, 'ADDRESS_INTEL_FAILED', err.message), err.message);
    }
    return sendError(res, err, 'Could not load address intelligence');
  }
};

/**
 * POST /api/orders/admin/items/:orderId/edit-pending-address/preview
 * Body: { addressPatch, alsoUpdateSavedAddress? }
 */
exports.previewPendingAddressEdit = async (req, res) => {
  try {
    const result = await previewOrApplyPendingAddressEdit({
      orderId: req.params.orderId,
      addressPatch: req.body?.addressPatch || req.body || {},
      alsoUpdateSavedAddress: Boolean(req.body?.alsoUpdateSavedAddress),
      commit: false,
      adminUserId: req.user?.id || req.user?._id || null,
      scopeMatch: getAdminOrderMatch(req)
    });
    return res.json({
      success: true,
      message: 'Address edit preview calculated',
      data: {
        ...result.preview,
        editableFields: EDITABLE_ADDRESS_FIELDS
      }
    });
  } catch (err) {
    if (!err.statusCode) {
      return sendError(res, createEditError(500, 'PENDING_ADDRESS_EDIT_FAILED', err.message), err.message);
    }
    return sendError(res, err, 'Could not preview address edit');
  }
};

/**
 * POST /api/orders/admin/items/:orderId/edit-pending-address
 * Body: { addressPatch, alsoUpdateSavedAddress? }
 */
exports.applyPendingAddressEdit = async (req, res) => {
  try {
    const result = await previewOrApplyPendingAddressEdit({
      orderId: req.params.orderId,
      addressPatch: req.body?.addressPatch || {},
      alsoUpdateSavedAddress: Boolean(req.body?.alsoUpdateSavedAddress),
      commit: true,
      adminUserId: req.user?.id || req.user?._id || null,
      scopeMatch: getAdminOrderMatch(req)
    });
    return res.json({
      success: true,
      message: result.refundInr > 0
        ? 'Address updated and refund initiated where applicable.'
        : 'Address updated successfully.',
      data: result
    });
  } catch (err) {
    if (!err.statusCode) {
      return sendError(res, createEditError(500, 'PENDING_ADDRESS_EDIT_FAILED', err.message), err.message);
    }
    return sendError(res, err, 'Could not apply address edit');
  }
};
