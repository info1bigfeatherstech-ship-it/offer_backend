const mongoose = require('mongoose');

const addressSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  /**
   * Which storefront owns this saved address.
   * Legacy docs without this field are treated as ecomm at query time.
   */
  storefront: {
    type: String,
    enum: ['ecomm', 'wholesale'],
    default: 'ecomm',
    index: true
  },

  fullName: {
    type: String,
    required: true,
    trim: true
  },

  phone: {
    type: String,
    required: true,
  },

  //  House / Flat / Building
  houseNumber: {
    type: String,
    required: true,
    trim: true
  },

  // Street / Area / Locality
  area: {
    type: String,
    required: true,
    trim: true
  },

  // Building (optional)
  building: {
    type: String,
    trim: true,
    default: ""
  },

  // Floor (optional)
  floor: {
    type: String,
    trim: true,
    default: ""
  },

  //  Landmark (VERY useful)
  landmark: {
    type: String,
    trim: true
  },

  // Keep your existing fields (important for flexibility)
  addressLine1: {
    type: String,
    required: true,
    trim: true
  },

  addressLine2: {
    type: String,
    trim: true
  },

  city: {
    type: String,
    required: true,
    trim: true
  },

  state: {
    type: String,
    required: true,
    trim: true
  },

  postalCode: {
    type: String,
    required: true,
    match: [/^\d{6}$/, 'Invalid pincode']
  },

  country: {
    type: String,
    default: 'India'
  },

  //  Address type
  addressType: {
    type: String,
    enum: ['home', 'work', 'other'],
    default: 'home'
  },

  //  Gift case support
  isGift: {
    type: Boolean,
    default: false
  },

  //  Delivery instructions
  deliveryInstructions: {
    type: String,
    trim: true
  },

  //  Future (DO NOT USE NOW, but keep)
  location: {
    lat: { type: Number },
    lng: { type: Number }
  },

  isDefault: {
    type: Boolean,
    default: false
  }

}, { timestamps: true });

addressSchema.index({ userId: 1, storefront: 1, isDefault: 1 });
addressSchema.index({ userId: 1, isDefault: 1 });
addressSchema.index({ postalCode: 1 }); // ✅ Add for delivery checks
addressSchema.index({ city: 1, state: 1 }); // ✅ Add for location-based queries
addressSchema.index({ createdAt: -1 }); // ✅ Add for sorting

addressSchema.pre('validate', function normalizeAddressStorefront() {
  if (!this.storefront) {
    this.storefront = 'ecomm';
  }
});

module.exports = mongoose.model('Address', addressSchema);
