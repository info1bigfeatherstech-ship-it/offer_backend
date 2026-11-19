const mongoose = require('mongoose');

/**
 * Per-storefront custom shipping-label layout (Shipmozo-backed orders only; never Shiprocket).
 * Ecomm → storefront=ecomm; wholesale → wholesale; dropship → dropship (layout only).
 * Dropship warehouse/pickup still uses ecomm shipping-provider settings at render time.
 */
const shipmozoLabelSettingsSchema = new mongoose.Schema(
  {
    storefront: {
      type: String,
      enum: ['ecomm', 'wholesale', 'dropship'],
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
