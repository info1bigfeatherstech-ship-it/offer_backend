'use strict';

const dropshipOrderService = require('../services/dropshipOrder.service');
const { assertDropshipPaymentAccess } = require('../services/dropshipOrderPayment.service');
const logger = require('../../utils/logger');

/** Lazy-load: core order.controller constructs Razorpay at import time. */
function getCoreOrderController() {
  return require('../../controllers/order.controller');
}

function respondError(res, statusCode, code, message, details = undefined) {
  const body = { success: false, code, message };
  if (details !== undefined) body.details = details;
  return res.status(statusCode).json(body);
}

function handleServiceError(res, err) {
  const status = err?.statusCode || 500;
  const code = err?.code || 'DROPSHIP_ORDER_ERROR';
  if (status >= 500) {
    logger.error('[dropshipOrder] unexpected', { message: err?.message, stack: err?.stack });
  }
  return respondError(res, status, code, err?.message || 'Request failed', err?.details);
}

exports.quoteOrder = async (req, res) => {
  try {
    const quote = await dropshipOrderService.quoteDropshipOrder(req.body || {});
    return res.json({ success: true, quote });
  } catch (err) {
    return handleServiceError(res, err);
  }
};

exports.createOrder = async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return respondError(res, 401, 'UNAUTHORIZED', 'Login required');
    }

    const result = await dropshipOrderService.createDropshipOrder({
      userId,
      body: req.body || {}
    });

    const orderPayload = dropshipOrderService.serializeDropshipOrder(result.order);
    const keyId = String(process.env.RAZORPAY_KEY_ID || '').trim();

    if (result.razorpayError || !result.razorpayOrder) {
      return res.status(201).json({
        success: true,
        message: 'Order created but payment initiation failed. Please retry payment.',
        order: orderPayload,
        razorpayError: true,
        razorpayErrorDetail: result.razorpayErrorDetail || null
      });
    }

    return res.status(201).json({
      success: true,
      message: 'Dropship order created. Complete Razorpay payment.',
      order: orderPayload,
      razorpay: {
        keyId,
        orderId: result.razorpayOrder.id,
        amount: result.razorpayOrder.amount,
        currency: result.razorpayOrder.currency || 'INR',
        receipt: result.razorpayOrder.receipt || orderPayload.orderId
      }
    });
  } catch (err) {
    return handleServiceError(res, err);
  }
};

/**
 * Verifies Razorpay payment for a dropship order, then reuses core verifyPayment
 * (inventory commit, hold clear, payment state) so behavior matches ecomm.
 */
exports.verifyPayment = async (req, res) => {
  try {
    const orderId = req.body?.orderId;
    const access = await assertDropshipPaymentAccess(orderId, req.userId);
    if (!access.ok) {
      return respondError(res, access.statusCode, access.code, access.message);
    }
    return getCoreOrderController().verifyPayment(req, res);
  } catch (err) {
    return handleServiceError(res, err);
  }
};

exports.listMyOrders = async (req, res) => {
  try {
    if (!req.userId) {
      return respondError(res, 401, 'UNAUTHORIZED', 'Login required');
    }
    const result = await dropshipOrderService.listDropshipOrdersForUser(req.userId, {
      page: req.query.page,
      limit: req.query.limit,
      ref: req.query.ref || req.query.dropshipRef
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    return handleServiceError(res, err);
  }
};

exports.getMyOrder = async (req, res) => {
  try {
    if (!req.userId) {
      return respondError(res, 401, 'UNAUTHORIZED', 'Login required');
    }
    const order = await dropshipOrderService.getDropshipOrderForUser(
      req.userId,
      req.params.orderId
    );
    if (!order) {
      return respondError(res, 404, 'ORDER_NOT_FOUND', 'Order not found');
    }
    return res.json({
      success: true,
      order: dropshipOrderService.serializeDropshipOrder(order)
    });
  } catch (err) {
    return handleServiceError(res, err);
  }
};
