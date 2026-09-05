const mongoose = require('mongoose');

/**
 * Per-storefront leads push policy (admin-controlled auto reminders + digests).
 */
const leadsPushSettingsSchema = new mongoose.Schema(
  {
    storefront: {
      type: String,
      required: true,
      enum: ['ecomm', 'wholesale'],
      unique: true,
      index: true,
    },
    /** When true, daily auto cart-reminder push runs for users with cart + subscription. */
    autoPushEnabled: {
      type: Boolean,
      default: false,
    },
    /** New products digest in IST windows 11–13 and 18–20. */
    newProductsAutoPushEnabled: {
      type: Boolean,
      default: false,
    },
    /** Daily auto wishlist-reminder push (same hour policy as cart). */
    wishlistAutoPushEnabled: {
      type: Boolean,
      default: false,
    },
    /** Watermark: products created after this are eligible for the next digest. */
    lastNewProductsDigestAt: {
      type: Date,
      default: null,
    },
    /** IST YYYY-MM-DD keys so each slot runs at most once per day. */
    lastNewProductsMorningDateKey: {
      type: String,
      default: null,
    },
    lastNewProductsEveningDateKey: {
      type: String,
      default: null,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('LeadsPushSettings', leadsPushSettingsSchema);
