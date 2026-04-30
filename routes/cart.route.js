// routes/cartRoutes.js
const express = require('express');
const router = express.Router();

const {
  addToCart,
  updateCartItem,
  checkout,
  mergeCart,
  removeCartItem,
  bulkRemove,
  clearCart,
  getCart
} = require('../controllers/cart.controller');

const { verifyToken } = require('../middlewares/auth.middleware');
const {
  resolveStorefrontMiddleware,
  requireWholesaleUserForWholesaleStorefront
} = require('../middlewares/storefront.middleware');

// Get logged-in user's cart
router.get('/', resolveStorefrontMiddleware, verifyToken, requireWholesaleUserForWholesaleStorefront, getCart);

// Add item to cart
router.post('/', resolveStorefrontMiddleware, verifyToken, requireWholesaleUserForWholesaleStorefront, addToCart);

// Update quantity (or remove if qty <= 0)
router.put('/item', resolveStorefrontMiddleware, verifyToken, requireWholesaleUserForWholesaleStorefront, updateCartItem);

// Remove single item
router.delete('/item', resolveStorefrontMiddleware, verifyToken, requireWholesaleUserForWholesaleStorefront, removeCartItem);

// Bulk remove items
router.post('/bulk-remove', resolveStorefrontMiddleware, verifyToken, requireWholesaleUserForWholesaleStorefront, bulkRemove);

// Clear full cart
router.delete('/clear', resolveStorefrontMiddleware, verifyToken, requireWholesaleUserForWholesaleStorefront, clearCart);

// Merge guest cart after login
router.post('/merge', resolveStorefrontMiddleware, verifyToken, requireWholesaleUserForWholesaleStorefront, mergeCart);



module.exports = router;