const mongoose = require('mongoose');

/**
 * Per-storefront leads push policy (admin-controlled auto cart reminder).
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
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('LeadsPushSettings', leadsPushSettingsSchema);
