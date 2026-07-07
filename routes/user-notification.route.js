const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/auth.middleware');
const {
  getUnreadCount,
  listNotifications,
  markAsRead,
  markAllAsRead
} = require('../controllers/user-notification.controller');

router.use(verifyToken);

router.get('/unread-count', getUnreadCount);
router.get('/', listNotifications);
router.patch('/read-all', markAllAsRead);
router.patch('/:id/read', markAsRead);

module.exports = router;
