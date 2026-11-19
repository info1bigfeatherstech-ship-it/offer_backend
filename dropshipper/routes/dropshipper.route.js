'use strict';

/**
 * Dropshipper-facing routes.
 * Mount: /api/dropshipper
 *
 * Public auth is registered before the partner JWT gate.
 * Catalog, serviceability, and orders require an active subscription.
 * me / logout / renew accept a dropshipper JWT even when the subscription is expired.
 */

const express = require('express');
const router = express.Router();
const { uploadWholesalerProofs } = require('../../middlewares/upload.middleware');
const {
  requireDropshipperAccess,
  requireActiveSubscription
} = require('../middlewares/dropshipperAccess.middleware');
const authController = require('../controllers/auth.controller');
const serviceabilityController = require('../controllers/serviceability.controller');
const catalogController = require('../controllers/catalog.controller');
const orderController = require('../controllers/order.controller');

function proofUpload(req, res, next) {
  uploadWholesalerProofs(req, res, (err) => {
    if (!err) return next();
    const tooBig = err.code === 'LIMIT_FILE_SIZE' || err.code === 'LIMIT_UNEXPECTED_FILE';
    return res.status(400).json({
      success: false,
      code: tooBig ? 'FILE_TOO_LARGE' : 'UPLOAD_INVALID',
      message: err.message || 'Invalid upload'
    });
  });
}

// Public — no JWT
router.get('/auth/subscription-settings', authController.getSubscriptionSettings);
router.post('/auth/register/start', authController.startRegistration);
router.post('/auth/register/create-payment', proofUpload, authController.createRegistrationPayment);
router.post('/auth/register/verify-payment', authController.verifyRegistrationPayment);
router.get('/auth/register/status/:requestId', authController.getRegistrationStatus);
router.post('/auth/activate/send-otp', authController.sendActivationOtp);
router.post('/auth/activate/complete', authController.completeActivation);
router.post('/auth/login', authController.login);
router.post('/auth/refresh', authController.refresh);

// Dropshipper JWT (subscription may be expired)
router.get('/auth/me', requireDropshipperAccess, authController.me);
router.post('/auth/logout', requireDropshipperAccess, authController.logout);
router.get('/auth/renew/quote', requireDropshipperAccess, authController.renewQuote);
router.post('/auth/renew/create-payment', requireDropshipperAccess, authController.renewCreatePayment);
router.post('/auth/renew/verify-payment', requireDropshipperAccess, authController.renewVerifyPayment);

router.use(requireDropshipperAccess, requireActiveSubscription);

// Serviceability
router.post('/serviceability/check', serviceabilityController.checkServiceability);

// Catalog
router.get('/catalog/products', catalogController.listProducts);
router.get('/catalog/products/:slug', catalogController.getProductBySlug);
router.get(
  '/catalog/variants/:productCode/download-pack',
  catalogController.getVariantDownloadPack
);
router.get('/catalog/variants/:productCode', catalogController.getVariantByProductCode);

// Orders + Razorpay (online only)
router.post('/orders/quote', orderController.quoteOrder);
router.post('/orders', orderController.createOrder);
router.post('/orders/verify-payment', orderController.verifyPayment);
router.get('/orders', orderController.listMyOrders);
// shipping-label BEFORE /:orderId so "shipping-label" is not captured as orderId
router.get('/orders/:orderId/shipping-label', orderController.downloadShippingLabel);
router.get('/orders/:orderId', orderController.getMyOrder);

module.exports = router;
