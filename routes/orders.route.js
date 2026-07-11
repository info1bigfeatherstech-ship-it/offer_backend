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
  // cancelOrder — intentionally not imported: customer cancel API disabled (see orders.route.js + order.controller.js).
  updateOrderStatus,
  generateInvoice,
  trackOrder,
  refundOrderPayment,
  createReturnRequest,
  listAdminReturnRequests,
  getAdminReturnRequest,
  adminDecideReturnRequest,
  adminInitiateReturnRefund,
  sendReturnChatMessage,
  getReturnChat
} = require('../controllers/order.controller');
const adminFulfillment = require('../controllers/admin-order-fulfillment.controller');
const adminPendingOrderEdit = require('../controllers/admin-pending-order-edit.controller');

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
router.post('/items/:orderId/return-chat', verifyToken, requireWholesaleUserForWholesaleStorefront, sendReturnChatMessage);
router.get('/items/:orderId/return-chat', verifyToken, requireWholesaleUserForWholesaleStorefront, getReturnChat);
router.get('/items/:orderId/invoice', verifyToken, requireWholesaleUserForWholesaleStorefront, generateInvoice);
// Intentionally commented: customer order cancellation disabled by product policy (uncomment with exports.cancelOrder in order.controller.js to restore).
// router.put('/items/:orderId/cancel', verifyToken, requireWholesaleUserForWholesaleStorefront, cancelOrder);

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
  '/admin/returns/requests/:orderId/chat',
  verifyToken,
  authorizeRoles('admin', 'order_manager'),
  sendReturnChatMessage
);

router.get(
  '/admin/returns/requests/:orderId/chat',
  verifyToken,
  authorizeRoles('admin', 'order_manager'),
  getReturnChat
);

router.post(
  '/admin/returns/requests/:orderId/reverse-pickup/retry',
  verifyToken,
  authorizeRoles('admin', 'order_manager'),
  adminFulfillment.adminReturnReversePickupRetry
);

router.post(
  '/admin/items/:orderId/edit-pending/preview',
  verifyToken,
  authorizeRoles('admin', 'order_manager'),
  adminPendingOrderEdit.previewPendingOrderEdit
);
router.post(
  '/admin/items/:orderId/edit-pending',
  verifyToken,
  authorizeRoles('admin', 'order_manager'),
  adminPendingOrderEdit.applyPendingOrderEdit
);
router.post(
  '/admin/items/bulk-approval/confirm',
  verifyToken,
  authorizeRoles('admin', 'order_manager'),
  adminFulfillment.adminBulkApprovalConfirm
);

router.post(
  '/admin/items/bulk-approval/cancel',
  verifyToken,
  authorizeRoles('admin', 'order_manager'),
  adminFulfillment.adminBulkApprovalCancel
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
  '/admin/items/bulk-fulfillment/sync-shiprocket',
  verifyToken,
  authorizeRoles('admin', 'order_manager'),
  adminFulfillment.adminBulkFulfillmentSyncShiprocket
);

router.get(
  '/admin/fulfillment/pickup-calendar',
  verifyToken,
  authorizeRoles('admin', 'order_manager'),
  adminFulfillment.adminFulfillmentPickupCalendar
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
  '/admin/items/bulk-documents/manifests-zip',
  verifyToken,
  authorizeRoles('admin', 'order_manager'),
  adminFulfillment.adminBulkManifestsZip
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
  '/admin/items/:orderId/fulfillment/sync-shiprocket',
  verifyToken,
  authorizeRoles('admin', 'order_manager'),
  adminFulfillment.adminFulfillmentSyncShiprocket
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
  '/admin/items/:orderId/fulfillment/manifest',
  verifyToken,
  authorizeRoles('admin', 'order_manager'),
  adminFulfillment.adminFulfillmentManifest
);

router.get(
  '/admin/items/:orderId/fulfillment/manifest-file',
  verifyToken,
  authorizeRoles('admin', 'order_manager'),
  adminFulfillment.adminFulfillmentManifestFile
);

router.post(
  '/admin/items/:orderId/fulfillment/cancel-shipment',
  verifyToken,
  authorizeRoles('admin', 'order_manager'),
  adminFulfillment.adminFulfillmentCancelShipment
);

router.post(
  '/admin/items/:orderId/fulfillment/retry-pickup',
  verifyToken,
  authorizeRoles('admin', 'order_manager'),
  adminFulfillment.adminFulfillmentRetryPickup
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
