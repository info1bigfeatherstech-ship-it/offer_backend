'use strict';

/**
 * Dropshipper-facing routes.
 * Mount: /api/dropshipper
 *
 * Auth: temporary staff JWT until Dropshipper model/login lands.
 */

const express = require('express');
const router = express.Router();
const { requireDropshipperAccess } = require('../middlewares/dropshipperAccess.middleware');
const serviceabilityController = require('../controllers/serviceability.controller');
const catalogController = require('../controllers/catalog.controller');
const orderController = require('../controllers/order.controller');

router.use(requireDropshipperAccess);

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
router.get('/orders/:orderId', orderController.getMyOrder);

module.exports = router;
