const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/auth.middleware');
const { authorizeRoles } = require('../middlewares/authorize-roles.middleware');
const { uploadReturnProofs } = require('../middlewares/upload.middleware');
const {
  requireWholesaleUserForWholesaleStorefront
} = require('../middlewares/storefront.middleware');
const {
  createOrder,
  verifyPayment,
  payOrderBalance,
  initiatePendingOrderPayment,
  abandonOnlineCheckout,
  getOrder,
  getUserOrders,
  cancelOrder,
  updateOrderStatus,
  generateInvoice,
  trackOrder,
  refundOrderPayment,
  createReturnRequest,
  listAdminReturnRequests,
  getAdminReturnRequest,
  adminDecideReturnRequest,
  adminInitiateReturnRefund
} = require('../controllers/order.controller');
const adminFulfillment = require('../controllers/admin-order-fulfillment.controller');

// Razorpay webhook is mounted in index.js (raw body) — not here

router.post('/items', verifyToken, requireWholesaleUserForWholesaleStorefront, createOrder);
router.post('/items/verify-payment', verifyToken, requireWholesaleUserForWholesaleStorefront, verifyPayment);
router.post('/items/:orderId/initiate-payment', verifyToken, requireWholesaleUserForWholesaleStorefront, initiatePendingOrderPayment);
router.post(
  '/items/:orderId/abandon-online-checkout',
  verifyToken,
  requireWholesaleUserForWholesaleStorefront,
  abandonOnlineCheckout
);
router.post('/items/:orderId/pay-balance', verifyToken, requireWholesaleUserForWholesaleStorefront, payOrderBalance);
router.get('/items', verifyToken, requireWholesaleUserForWholesaleStorefront, getUserOrders);
router.get('/items/:orderId', verifyToken, requireWholesaleUserForWholesaleStorefront, getOrder);
router.get('/items/:orderId/track', verifyToken, requireWholesaleUserForWholesaleStorefront, trackOrder);
router.post('/items/:orderId/return-request', verifyToken, requireWholesaleUserForWholesaleStorefront, uploadReturnProofs, createReturnRequest);
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

router.get(
  '/admin/returns/requests',
  verifyToken,
  authorizeRoles('admin', 'order_manager'),
  listAdminReturnRequests
);

router.get(
  '/admin/returns/requests/:orderId',
  verifyToken,
  authorizeRoles('admin', 'order_manager'),
  getAdminReturnRequest
);

router.post(
  '/admin/returns/requests/:orderId/decision',
  verifyToken,
  authorizeRoles('admin', 'order_manager'),
  adminDecideReturnRequest
);

router.post(
  '/admin/returns/requests/:orderId/refund',
  verifyToken,
  authorizeRoles('admin', 'order_manager'),
  adminInitiateReturnRefund
);

router.post(
  '/admin/returns/requests/:orderId/reverse-pickup/retry',
  verifyToken,
  authorizeRoles('admin', 'order_manager'),
  adminFulfillment.adminReturnReversePickupRetry
);

router.post(
  '/admin/items/bulk-fulfillment/ship-now',
  verifyToken,
  authorizeRoles('admin', 'order_manager'),
  adminFulfillment.adminBulkFulfillmentShipNow
);

router.post(
  '/admin/items/bulk-fulfillment/schedule-pickup',
  verifyToken,
  authorizeRoles('admin', 'order_manager'),
  adminFulfillment.adminBulkFulfillmentSchedulePickup
);

router.post(
  '/admin/items/bulk-documents/tax-invoices-zip',
  verifyToken,
  authorizeRoles('admin', 'order_manager'),
  adminFulfillment.adminBulkTaxInvoicesZip
);

router.post(
  '/admin/items/bulk-documents/shipping-labels-zip',
  verifyToken,
  authorizeRoles('admin', 'order_manager'),
  adminFulfillment.adminBulkShippingLabelsZip
);

router.post(
  '/admin/items/:orderId/fulfillment/ensure-shipment',
  verifyToken,
  authorizeRoles('admin', 'order_manager'),
  adminFulfillment.adminFulfillmentEnsureShipment
);

router.post(
  '/admin/items/:orderId/fulfillment/assign-ship',
  verifyToken,
  authorizeRoles('admin', 'order_manager'),
  adminFulfillment.adminFulfillmentAssignShip
);

router.post(
  '/admin/items/:orderId/fulfillment/schedule-pickup',
  verifyToken,
  authorizeRoles('admin', 'order_manager'),
  adminFulfillment.adminFulfillmentSchedulePickup
);

router.post(
  '/admin/items/:orderId/fulfillment/shipping-label',
  verifyToken,
  authorizeRoles('admin', 'order_manager'),
  adminFulfillment.adminFulfillmentShippingLabel
);

router.get(
  '/admin/items/:orderId/fulfillment/shipping-label-file',
  verifyToken,
  authorizeRoles('admin', 'order_manager'),
  adminFulfillment.adminFulfillmentShippingLabelFile
);

router.post(
  '/admin/items/:orderId/fulfillment/cancel-shipment',
  verifyToken,
  authorizeRoles('admin', 'order_manager'),
  adminFulfillment.adminFulfillmentCancelShipment
);

router.get(
  '/admin/items/:orderId/fulfillment/couriers',
  verifyToken,
  authorizeRoles('admin', 'order_manager'),
  adminFulfillment.adminFulfillmentListCouriers
);

router.get(
  '/admin/items/:orderId/invoice-html',
  verifyToken,
  authorizeRoles('admin', 'order_manager'),
  adminFulfillment.adminInvoiceHtml
);

module.exports = router;
