// routes/userProductRoutes.js
const express = require('express');
const router = express.Router();
const userProductController = require('../controllers/user-product.controller');
const { optionalAuth } = require('../middlewares/user-type-optional.middleware');
const { resolveStorefrontMiddleware } = require('../middlewares/storefront.middleware');

// Storefront first (ecomm default), then optional auth for wholesaler pricing.
router.get(
  '/search',
  resolveStorefrontMiddleware,
  optionalAuth,
  userProductController.searchProducts
);
router.get(
  '/all',
  resolveStorefrontMiddleware,
  optionalAuth,
  userProductController.getProducts
);
router.get(
  '/featured',
  resolveStorefrontMiddleware,
  optionalAuth,
  userProductController.getFeaturedProducts
);
router.get(
  '/category/:slug',
  resolveStorefrontMiddleware,
  optionalAuth,
  userProductController.getProductsByCategory
);
router.get(
  '/:slug/related',
  resolveStorefrontMiddleware,
  optionalAuth,
  userProductController.getRelatedProducts
);
router.get(
  '/detailed/:id',
  resolveStorefrontMiddleware,
  optionalAuth,
  userProductController.getProductDetails
);
router.get(
  '/:slug',
  resolveStorefrontMiddleware,
  optionalAuth,
  userProductController.getProductBySlug
);

module.exports = router;