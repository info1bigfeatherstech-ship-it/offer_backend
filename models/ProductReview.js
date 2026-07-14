const mongoose = require('mongoose');

const SOURCES = ['customer', 'admin'];

const productReviewSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
      index: true
    },
    source: {
      type: String,
      enum: SOURCES,
      required: true,
      index: true
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true
    },
    /**
     * Delivered order that verified this purchase (customer reviews only).
     */
    orderId: {
      type: String,
      trim: true,
      default: null,
      index: true
    },
    variantId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null
    },
    verifiedPurchase: {
      type: Boolean,
      default: false,
      index: true
    },
    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5
    },
    comment: {
      type: String,
      maxlength: 2000,
      default: ''
    },
    images: {
      type: [
        {
          url: { type: String, required: true },
          publicId: { type: String, default: null }
        }
      ],
      default: []
    },
    /**
     * Shown on storefront for source === 'admin'. Ignored for customer reviews.
     */
    displayName: {
      type: String,
      maxlength: 120,
      trim: true,
      default: ''
    },
    isActive: {
      type: Boolean,
      default: function defaultActive() {
        return this.source === 'admin';
      }
    }
  },
  { timestamps: true }
);

productReviewSchema.index({ productId: 1, isActive: 1, rating: -1, createdAt: -1 });
productReviewSchema.index(
  { productId: 1, userId: 1 },
  {
    unique: true,
    partialFilterExpression: { source: 'customer', userId: { $type: 'objectId' } }
  }
);

/**
 * Mongoose 9 document `pre('validate')` hooks do not use a `next` callback.
 * Use sync logic or return a Promise; throw to fail validation.
 */
productReviewSchema.pre('validate', function normalizeProductReview() {
  if (this.source === 'customer') {
    if (!this.userId) {
      throw new Error('Customer reviews require userId');
    }
    this.displayName = '';
  } else if (this.source === 'admin') {
    this.userId = null;
    this.orderId = null;
    this.variantId = null;
    this.verifiedPurchase = false;
    this.images = [];
  }
});

module.exports = mongoose.model('ProductReview', productReviewSchema);
module.exports.REVIEW_SOURCES = SOURCES;
