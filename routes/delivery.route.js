const express = require('express');
const router = express.Router();
const { checkDeliveryAvailability, getDeliveryCharges } = require('../controllers/delivery.controller');

// Public (guest-safe): global optionalAuth already sets req.userId when a token is present.
// Logged-in users still get weight/dims from their server cart; guests may send items[].
router.post('/check-delivery', checkDeliveryAvailability);
router.get('/delivery-charges/:pincode', getDeliveryCharges);

module.exports = router;
