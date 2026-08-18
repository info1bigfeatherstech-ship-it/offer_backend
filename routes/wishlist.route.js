const express = require('express');
const router = express.Router();
const wishlistController = require('../controllers/wishlist.controller');
const { verifyToken } = require('../middlewares/auth.middleware');
const {
  resolveStorefrontMiddleware,
  requireWholesaleUserForWholesaleStorefront
} = require('../middlewares/storefront.middleware');

router.get('/', resolveStorefrontMiddleware, verifyToken, requireWholesaleUserForWholesaleStorefront, wishlistController.getWishlist);

router.post('/add', resolveStorefrontMiddleware, verifyToken, requireWholesaleUserForWholesaleStorefront, wishlistController.addToWishlist);

router.delete(
  '/remove/:productSlug',
  resolveStorefrontMiddleware,
  verifyToken,
  requireWholesaleUserForWholesaleStorefront,
  wishlistController.removeFromWishlist
);

router.post('/merge', resolveStorefrontMiddleware, verifyToken, requireWholesaleUserForWholesaleStorefront, wishlistController.mergeWishlist);

router.delete(
  '/remove-bulk',
  resolveStorefrontMiddleware,
  verifyToken,
  requireWholesaleUserForWholesaleStorefront,
  wishlistController.removeBulkFromWishlist
);

router.delete(
  '/clear',
  resolveStorefrontMiddleware,
  verifyToken,
  requireWholesaleUserForWholesaleStorefront,
  wishlistController.clearWishlist
);

router.post(
  '/move-to-cart',
  resolveStorefrontMiddleware,
  verifyToken,
  requireWholesaleUserForWholesaleStorefront,
  wishlistController.moveToCart
);

module.exports = router;