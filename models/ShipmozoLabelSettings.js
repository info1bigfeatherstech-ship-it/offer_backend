const mongoose = require('mongoose');

/**
 * Per-storefront Shipmozo shipping-label layout.
 * Ecomm admin writes storefront=ecomm; wholesale admin writes storefront=wholesale.
 * Applied only when generating custom labels for Shipmozo orders (never Shiprocket).
 */
const shipmozoLabelSettingsSchema = new mongoose.Schema(
  {
    storefront: {
      type: String,
      enum: ['ecomm', 'wholesale'],
      required: true,
      unique: true,
      index: true
    },
    settings: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('ShipmozoLabelSettings', shipmozoLabelSettingsSchema);
