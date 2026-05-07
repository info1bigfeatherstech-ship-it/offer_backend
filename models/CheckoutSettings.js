const mongoose = require('mongoose');

/**
 * Per-storefront checkout policy (COD toggle, admin-driven partial payment %).
 * One document per storefront key (ecomm | wholesale).
 */
const checkoutSettingsSchema = new mongoose.Schema(
  {
    storefront: {
      type: String,
      required: true,
      enum: ['ecomm', 'wholesale'],
      unique: true,
      index: true
    },
    /** When false, partial/advance plan is rejected and UI should hide it (via GET /checkout/settings). */
    partialPaymentEnabled: { type: Boolean, default: true },
    /**
     * Percent of order total charged as first online payment when partial is enabled (1–100).
     * Meaningful only when partialPaymentEnabled is true; ignored otherwise.
     */
    partialPaymentPercent: {
      type: Number,
      default: null,
      min: 1,
      max: 100
    },
    /** When false, COD is rejected at quote/confirm/order (UI should hide via settings). */
    codEnabled: { type: Boolean, default: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('CheckoutSettings', checkoutSettingsSchema);
