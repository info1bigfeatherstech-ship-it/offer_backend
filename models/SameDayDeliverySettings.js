const mongoose = require('mongoose');

/**
 * Ecomm-only same-day delivery pincode allowlist.
 * Separate collection — does not touch shipping provider or order documents.
 */
const sameDayDeliverySettingsSchema = new mongoose.Schema(
  {
    storefront: {
      type: String,
      enum: ['ecomm'],
      required: true,
      unique: true,
      default: 'ecomm',
    },
    enabled: { type: Boolean, default: false },
    pincodes: {
      type: [String],
      default: [],
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('SameDayDeliverySettings', sameDayDeliverySettingsSchema);
