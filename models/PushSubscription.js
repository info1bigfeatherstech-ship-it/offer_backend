const mongoose = require('mongoose');

const pushSubscriptionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    endpoint: {
      type: String,
      required: true,
      trim: true,
      unique: true,
    },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true },
    },
    userAgent: {
      type: String,
      default: null,
      maxlength: 512,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    lastCartReminderPushAt: {
      type: Date,
      default: null,
      index: true,
    },
    lastWishlistReminderPushAt: {
      type: Date,
      default: null,
      index: true,
    },
    lastPushAt: {
      type: Date,
      default: null,
    },
    failureCount: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { timestamps: true }
);

pushSubscriptionSchema.index({ userId: 1, isActive: 1 });

module.exports = mongoose.model('PushSubscription', pushSubscriptionSchema);
