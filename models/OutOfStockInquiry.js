const mongoose = require('mongoose');

const STATUS_ENUM = ['pending', 'notifying', 'notified', 'closed'];

const outOfStockInquirySchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
      index: true,
    },
    variantId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    productSlug: { type: String, trim: true, default: null },
    productName: { type: String, trim: true, default: null },
    variantSku: { type: String, trim: true, default: null },
    productImage: { type: String, trim: true, default: null },

    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: null,
      index: true,
    },
    phone: {
      type: String,
      trim: true,
      default: null,
      index: true,
    },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },

    storefront: {
      type: String,
      enum: ['ecomm', 'wholesale'],
      default: 'ecomm',
      index: true,
    },

    status: {
      type: String,
      enum: STATUS_ENUM,
      default: 'pending',
      index: true,
    },

    source: {
      type: String,
      enum: ['pdp'],
      default: 'pdp',
    },

    notifiedAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
    adminNote: { type: String, trim: true, maxlength: 500, default: null },

    notifyAttempts: { type: Number, default: 0 },
    lastNotifyAttemptAt: { type: Date, default: null },
    lastNotifyError: { type: String, trim: true, maxlength: 500, default: null },
    notifyChannelsSent: { type: [String], default: [] },
  },
  { timestamps: true }
);

outOfStockInquirySchema.index({ createdAt: -1 });
outOfStockInquirySchema.index({ productId: 1, variantId: 1, status: 1, createdAt: -1 });
outOfStockInquirySchema.index({ storefront: 1, status: 1, createdAt: -1 });

outOfStockInquirySchema.pre('validate', function ensureContact() {
  if (!this.email) {
    this.invalidate('email', 'email is required');
  }
  if (!this.phone) {
    this.invalidate('phone', 'phone is required');
  }
});

module.exports = mongoose.model('OutOfStockInquiry', outOfStockInquirySchema);
module.exports.STATUS_ENUM = STATUS_ENUM;
