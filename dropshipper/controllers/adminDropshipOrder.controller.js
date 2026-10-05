'use strict';

const dropshipOrderService = require('../services/dropshipOrder.service');
const logger = require('../../utils/logger');

function respondError(res, statusCode, code, message) {
  return res.status(statusCode).json({ success: false, code, message });
}

exports.listOrders = async (req, res) => {
  try {
    const result = await dropshipOrderService.listAdminDropshipOrders({
      page: req.query.page,
      limit: req.query.limit,
      ref: req.query.ref || req.query.dropshipRef,
      q: req.query.q || req.query.search,
      paymentStatus: req.query.paymentStatus,
      orderStatus: req.query.orderStatus
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    logger.error('[adminDropshipOrder] list failed', { message: err?.message });
    return respondError(res, 500, 'DROPSHIP_ORDER_LIST_FAILED', err?.message || 'List failed');
  }
};

exports.getOrder = async (req, res) => {
  try {
    const order = await dropshipOrderService.getAdminDropshipOrder(req.params.orderId);
    if (!order) {
      return respondError(res, 404, 'ORDER_NOT_FOUND', 'Dropship order not found');
    }
    return res.json({
      success: true,
      order: dropshipOrderService.serializeDropshipOrder(order)
    });
  } catch (err) {
    logger.error('[adminDropshipOrder] get failed', { message: err?.message });
    return respondError(res, 500, 'DROPSHIP_ORDER_GET_FAILED', err?.message || 'Get failed');
  }
};
