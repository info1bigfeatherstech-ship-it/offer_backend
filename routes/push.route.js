const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/auth.middleware');
const {
  getVapidPublicKeyHandler,
  subscribePush,
  unsubscribePush,
  getPushStatus,
} = require('../controllers/push-subscription.controller');

router.get('/vapid-public-key', getVapidPublicKeyHandler);
router.get('/status', verifyToken, getPushStatus);
router.post('/subscribe', verifyToken, subscribePush);
router.delete('/unsubscribe', verifyToken, unsubscribePush);

module.exports = router;
