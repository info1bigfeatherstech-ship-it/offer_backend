const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/auth.middleware');
const { authorizeRoles } = require('../middlewares/authorize-roles.middleware');
const {
  requireWholesaleUserForWholesaleStorefront
} = require('../middlewares/storefront.middleware');
const {
  createOrder,
  verifyPayment,
  payOrderBalance,
  initiatePendingOrderPayment,
  getOrder,
  getUserOrders,
  cancelOrder,
  updateOrderStatus,
  generateInvoice,
  trackOrder,
  refundOrderPayment
} = require('../controllers/order.controller');

// Razorpay webhook is mounted in index.js (raw body) — not here

router.post('/items', verifyToken, requireWholesaleUserForWholesaleStorefront, createOrder);
router.post('/items/verify-payment', verifyToken, requireWholesaleUserForWholesaleStorefront, verifyPayment);
router.post('/items/:orderId/initiate-payment', verifyToken, requireWholesaleUserForWholesaleStorefront, initiatePendingOrderPayment);
router.post('/items/:orderId/pay-balance', verifyToken, requireWholesaleUserForWholesaleStorefront, payOrderBalance);
router.get('/items', verifyToken, requireWholesaleUserForWholesaleStorefront, getUserOrders);
router.get('/items/:orderId', verifyToken, requireWholesaleUserForWholesaleStorefront, getOrder);
router.get('/items/:orderId/track', verifyToken, requireWholesaleUserForWholesaleStorefront, trackOrder);
router.get('/items/:orderId/invoice', verifyToken, requireWholesaleUserForWholesaleStorefront, generateInvoice);
router.put('/items/:orderId/cancel', verifyToken, requireWholesaleUserForWholesaleStorefront, cancelOrder);

router.post(
  '/admin/items/:orderId/refund',
  verifyToken,
  authorizeRoles('admin'),
  refundOrderPayment
);

router.put(
  '/admin/items/:orderId/status',
  verifyToken,
  authorizeRoles('admin', 'order_manager'),
  updateOrderStatus
);

module.exports = router;
