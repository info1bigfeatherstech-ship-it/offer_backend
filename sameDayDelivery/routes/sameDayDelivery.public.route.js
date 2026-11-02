'use strict';

const express = require('express');
const { verifyToken } = require('../../middlewares/auth.middleware');
const {
  requireWholesaleUserForWholesaleStorefront,
} = require('../../middlewares/storefront.middleware');
const {
  getEligibility,
  quoteSameDay,
  confirmSameDay,
} = require('../controllers/sameDayDelivery.public.controller');

const router = express.Router();

router.use(verifyToken);
router.use(requireWholesaleUserForWholesaleStorefront);

router.get('/eligibility', getEligibility);
router.post('/quote', quoteSameDay);
router.post('/confirm', confirmSameDay);

module.exports = router;
