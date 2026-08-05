const mongoose = require('mongoose');
const { SHIPPING_PROVIDERS } = require('../constants/shippingProviders');

/**
 * Singleton shipping-partner settings (one doc).
 * activeProvider applies only to NEW checkout / place-order flows.
 * Existing orders keep order.shippingProvider forever.
 */
const shippingProviderSettingsSchema = new mongoose.Schema(
  {
    /** Singleton key — always "default" */
    key: {
      type: String,
      required: true,
      unique: true,
      default: 'default',
      immutable: true
    },
    activeProvider: {
      type: String,
      enum: Object.values(SHIPPING_PROVIDERS),
      default: SHIPPING_PROVIDERS.SHIPROCKET,
      required: true
    },
    shipmozo: {
      /** When false, cannot activate shipmozo even if keys exist in env */
      enabled: { type: Boolean, default: true },
      /** Optional override; env SHIPMOZO_PUBLIC_KEY used when empty */
      publicKey: { type: String, default: null, trim: true },
      /** Optional override; env SHIPMOZO_PRIVATE_KEY used when empty */
      privateKey: { type: String, default: null, trim: true },
      /** Shipmozo warehouse id from get-warehouses / create-warehouse */
      warehouseId: { type: String, default: null, trim: true },
      /**
       * Pickup pincode for Shipmozo rate/serviceability.
       * Independent from STORE_PINCODE / PICKUP_PINCODE (Shiprocket-only).
       */
      pickupPincode: { type: String, default: null, trim: true },
      /** Optional warehouse address title for create-warehouse */
      warehouseAddressTitle: { type: String, default: null, trim: true }
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('ShippingProviderSettings', shippingProviderSettingsSchema);
