const crypto = require('crypto');
const mongoose = require('mongoose');

const orderIdempotencyKeySchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    key: {
      type: String,
      required: true,
      trim: true
    },
    requestHash: {
      type: String,
      required: true
    },
    status: {
      type: String,
      enum: ['pending', 'completed'],
      default: 'pending',
      index: true
    },
    orderId: {
      type: String,
      default: null
    },
    completedAt: {
      type: Date,
      default: null
    }
  },
  { timestamps: true }
);

orderIdempotencyKeySchema.index({ userId: 1, key: 1 }, { unique: true });
orderIdempotencyKeySchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 7 });

orderIdempotencyKeySchema.statics.buildRequestHash = function buildRequestHash(payload) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(payload || {}))
    .digest('hex');
};

module.exports = mongoose.model('OrderIdempotencyKey', orderIdempotencyKeySchema);
