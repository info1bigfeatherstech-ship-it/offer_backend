const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/auth.middleware');
const { authorizeRoles } = require('../middlewares/authorize-roles.middleware');
const { uploadReturnProofs } = require('../middlewares/upload.middleware');
const {
  requireWholesaleUserForWholesaleStorefront
} = require('../middlewares/storefront.middleware');
const { requireAdminStorefrontScope } = require('../middlewares/admin-storefront-scope.middleware');
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
const adminPendingOrderAddress = require('../controllers/admin-pending-order-address.controller');

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

/**
 * Admin order ops under /admin/* — storefront-scoped (non-strict):
 * missing header → ecomm default, or single allowedStorefronts entry (wholesale-only staff).
 * Does not break live ecomm admin if x-storefront is omitted on these paths.
 */
const adminOrderStaff = [verifyToken, authorizeRoles('admin', 'order_manager'), requireAdminStorefrontScope];
const adminOrderRefund = [verifyToken, authorizeRoles('admin'), requireAdminStorefrontScope];

router.post('/admin/items/:orderId/refund', ...adminOrderRefund, refundOrderPayment);

router.put('/admin/items/:orderId/status', ...adminOrderStaff, updateOrderStatus);

router.get('/admin/returns/requests', ...adminOrderStaff, listAdminReturnRequests);

router.get('/admin/returns/requests/:orderId', ...adminOrderStaff, getAdminReturnRequest);

router.post('/admin/returns/requests/:orderId/decision', ...adminOrderStaff, adminDecideReturnRequest);

router.post('/admin/returns/requests/:orderId/refund', ...adminOrderStaff, adminInitiateReturnRefund);

router.post('/admin/returns/requests/:orderId/chat', ...adminOrderStaff, sendReturnChatMessage);

router.get('/admin/returns/requests/:orderId/chat', ...adminOrderStaff, getReturnChat);

router.post(
  '/admin/returns/requests/:orderId/reverse-pickup/retry',
  ...adminOrderStaff,
  adminFulfillment.adminReturnReversePickupRetry
);

router.post(
  '/admin/items/:orderId/edit-pending/preview',
  ...adminOrderStaff,
  adminPendingOrderEdit.previewPendingOrderEdit
);
router.post(
  '/admin/items/:orderId/edit-pending',
  ...adminOrderStaff,
  adminPendingOrderEdit.applyPendingOrderEdit
);

router.get(
  '/admin/items/:orderId/address-intelligence',
  ...adminOrderStaff,
  adminPendingOrderAddress.getAddressIntelligence
);

router.post(
  '/admin/items/:orderId/edit-pending-address/preview',
  ...adminOrderStaff,
  adminPendingOrderAddress.previewPendingAddressEdit
);

router.post(
  '/admin/items/:orderId/edit-pending-address',
  ...adminOrderStaff,
  adminPendingOrderAddress.applyPendingAddressEdit
);

router.post(
  '/admin/items/bulk-approval/confirm',
  ...adminOrderStaff,
  adminFulfillment.adminBulkApprovalConfirm
);

router.post(
  '/admin/items/bulk-approval/cancel',
  ...adminOrderStaff,
  adminFulfillment.adminBulkApprovalCancel
);

router.post(
  '/admin/items/bulk-fulfillment/ship-now',
  ...adminOrderStaff,
  adminFulfillment.adminBulkFulfillmentShipNow
);

router.post(
  '/admin/items/bulk-fulfillment/schedule-pickup',
  ...adminOrderStaff,
  adminFulfillment.adminBulkFulfillmentSchedulePickup
);

router.post(
  '/admin/items/bulk-fulfillment/sync-shiprocket',
  ...adminOrderStaff,
  adminFulfillment.adminBulkFulfillmentSyncShiprocket
);

router.get(
  '/admin/fulfillment/pickup-calendar',
  ...adminOrderStaff,
  adminFulfillment.adminFulfillmentPickupCalendar
);

router.post(
  '/admin/items/bulk-documents/tax-invoices-zip',
  ...adminOrderStaff,
  adminFulfillment.adminBulkTaxInvoicesZip
);

router.post(
  '/admin/items/bulk-documents/shipping-labels-zip',
  ...adminOrderStaff,
  adminFulfillment.adminBulkShippingLabelsZip
);

router.post(
  '/admin/items/bulk-documents/manifests-zip',
  ...adminOrderStaff,
  adminFulfillment.adminBulkManifestsZip
);

router.post(
  '/admin/items/:orderId/fulfillment/ensure-shipment',
  ...adminOrderStaff,
  adminFulfillment.adminFulfillmentEnsureShipment
);

router.post(
  '/admin/items/:orderId/fulfillment/assign-ship',
  ...adminOrderStaff,
  adminFulfillment.adminFulfillmentAssignShip
);

router.post(
  '/admin/items/:orderId/fulfillment/sync-shiprocket',
  ...adminOrderStaff,
  adminFulfillment.adminFulfillmentSyncShiprocket
);

router.post(
  '/admin/items/:orderId/fulfillment/schedule-pickup',
  ...adminOrderStaff,
  adminFulfillment.adminFulfillmentSchedulePickup
);

router.post(
  '/admin/items/:orderId/fulfillment/shipping-label',
  ...adminOrderStaff,
  adminFulfillment.adminFulfillmentShippingLabel
);

router.get(
  '/admin/items/:orderId/fulfillment/shipping-label-file',
  ...adminOrderStaff,
  adminFulfillment.adminFulfillmentShippingLabelFile
);

router.post(
  '/admin/items/:orderId/fulfillment/manifest',
  ...adminOrderStaff,
  adminFulfillment.adminFulfillmentManifest
);

router.get(
  '/admin/items/:orderId/fulfillment/manifest-file',
  ...adminOrderStaff,
  adminFulfillment.adminFulfillmentManifestFile
);

router.post(
  '/admin/items/:orderId/fulfillment/cancel-shipment',
  ...adminOrderStaff,
  adminFulfillment.adminFulfillmentCancelShipment
);

router.post(
  '/admin/items/:orderId/fulfillment/retry-pickup',
  ...adminOrderStaff,
  adminFulfillment.adminFulfillmentRetryPickup
);

router.get(
  '/admin/items/:orderId/fulfillment/couriers',
  ...adminOrderStaff,
  adminFulfillment.adminFulfillmentListCouriers
);

router.get(
  '/admin/items/:orderId/invoice-html',
  ...adminOrderStaff,
  adminFulfillment.adminInvoiceHtml
);

module.exports = router;
