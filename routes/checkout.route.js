const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/auth.middleware');
const { quoteCheckout, confirmCheckout } = require('../controllers/checkout.controller');
const {
  requireWholesaleUserForWholesaleStorefront
} = require('../middlewares/storefront.middleware');

router.post('/quote', verifyToken, requireWholesaleUserForWholesaleStorefront, quoteCheckout);
router.post('/confirm', verifyToken, requireWholesaleUserForWholesaleStorefront, confirmCheckout);

module.exports = router;
