const UserNotification = require('../models/UserNotification');
const logger = require('../utils/logger');

function mapNotificationRow(doc) {
  const n = doc && typeof doc.toObject === 'function' ? doc.toObject() : doc;
  return {
    id: String(n._id),
    orderId: n.orderId,
    type: n.type,
    title: n.title,
    body: n.body,
    read: Boolean(n.read),
    sentAt: n.sentAt,
    metadata: n.metadata || {}
  };
}

/**
 * GET /api/notifications/unread-count
 */
exports.getUnreadCount = async (req, res) => {
  try {
    const userId = req.userId || req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

    const count = await UserNotification.countDocuments({ userId, read: false });
    return res.json({ success: true, data: { count } });
  } catch (error) {
    logger.error('[user-notification] getUnreadCount failed', { message: error.message });
    return res.status(500).json({
      success: false,
      code: 'NOTIFICATION_COUNT_FAILED',
      message: 'Could not load notification count'
    });
  }
};

/**
 * GET /api/notifications?page=1&limit=20
 */
exports.listNotifications = async (req, res) => {
  try {
    const userId = req.userId || req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      UserNotification.find({ userId }).sort({ sentAt: -1 }).skip(skip).limit(limit).lean(),
      UserNotification.countDocuments({ userId })
    ]);

    return res.json({
      success: true,
      data: {
        notifications: items.map(mapNotificationRow),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.max(1, Math.ceil(total / limit)),
          hasMore: skip + items.length < total
        }
      }
    });
  } catch (error) {
    logger.error('[user-notification] listNotifications failed', { message: error.message });
    return res.status(500).json({
      success: false,
      code: 'NOTIFICATION_LIST_FAILED',
      message: 'Could not load notifications'
    });
  }
};

/**
 * PATCH /api/notifications/:id/read
 */
exports.markAsRead = async (req, res) => {
  try {
    const userId = req.userId || req.user?.id;
    const { id } = req.params;

    const updated = await UserNotification.findOneAndUpdate(
      { _id: id, userId },
      { $set: { read: true } },
      { new: true }
    ).lean();

    if (!updated) {
      return res.status(404).json({
        success: false,
        code: 'NOTIFICATION_NOT_FOUND',
        message: 'Notification not found'
      });
    }

    return res.json({ success: true, data: mapNotificationRow(updated) });
  } catch (error) {
    logger.error('[user-notification] markAsRead failed', { message: error.message });
    return res.status(500).json({
      success: false,
      code: 'NOTIFICATION_MARK_READ_FAILED',
      message: 'Could not mark notification as read'
    });
  }
};

/**
 * PATCH /api/notifications/read-all
 */
exports.markAllAsRead = async (req, res) => {
  try {
    const userId = req.userId || req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

    const result = await UserNotification.updateMany({ userId, read: false }, { $set: { read: true } });
    return res.json({
      success: true,
      data: { modifiedCount: result.modifiedCount || 0 }
    });
  } catch (error) {
    logger.error('[user-notification] markAllAsRead failed', { message: error.message });
    return res.status(500).json({
      success: false,
      code: 'NOTIFICATION_MARK_ALL_READ_FAILED',
      message: 'Could not mark all notifications as read'
    });
  }
};
