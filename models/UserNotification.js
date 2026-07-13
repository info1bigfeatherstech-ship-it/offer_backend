const mongoose = require('mongoose');

const userNotificationSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    orderId: { type: String, required: true, trim: true, index: true },
    type: {
      type: String,
      enum: [
        'rto_initiated',
        'refund_initiated',
        'refund_processed',
        'refund_rejected',
        'refund_not_applicable',
        'refund_failed',
        'order_amended'
      ],
      required: true
    },
    title: { type: String, required: true, trim: true },
    body: { type: String, required: true },
    read: { type: Boolean, default: false, index: true },
    sentAt: { type: Date, default: Date.now, index: true },
    metadata: {
      reason: { type: String, default: null },
      refundAmount: { type: Number, default: null },
      orderTotal: { type: Number, default: null },
      policyUrl: { type: String, default: null }
    }
  },
  { timestamps: true }
);

userNotificationSchema.index({ userId: 1, orderId: 1, type: 1 }, { unique: true });
userNotificationSchema.index({ userId: 1, read: 1, sentAt: -1 });

module.exports = mongoose.model('UserNotification', userNotificationSchema);
