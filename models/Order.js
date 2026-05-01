// models/Order.js
const mongoose = require('mongoose');
const crypto = require('crypto');

const orderItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: mongoose.Schema.Types.ObjectId },
    quantity: { type: Number, required: true, min: 1 },
    priceSnapshot: {
      base: { type: Number, required: true },
      sale: { type: Number, default: null },
      total: { type: Number, required: true }
    },
    variantAttributesSnapshot: [
      { key: String, value: String }
    ],
    userType: { type: String, enum: ['normal', 'wholesaler'], required: true },
    
    // ✅ NEW FIELDS FOR AGGREGATOR
    hsnCode: { type: String, trim: true, uppercase: true, default: null },
    gstRate: { type: Number, min: 0, default: null },
    isFragile: { type: Boolean, default: false }
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    orderId: { type: String, unique: true, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    items: { type: [orderItemSchema], required: true },
    
    // Price breakdown (calculated on server)
    subtotal: { type: Number, required: true },
    deliveryCharges: { type: Number, required: true, default: 0 },
    tax: { type: Number, required: true, default: 0 },
    discount: { type: Number, default: 0 },
    totalAmount: { type: Number, required: true },
    
    address: { type: mongoose.Schema.Types.ObjectId, ref: 'Address', required: true },
    addressSnapshot: { type: Object, required: true },
    
    userType: { type: String, enum: ['normal', 'wholesaler'], required: true },
    
    orderStatus: { 
      type: String, 
      enum: ['pending', 'confirmed', 'processing', 'shipped', 'out_for_delivery', 'delivered', 'cancelled', 'return_requested', 'payment_failed'], 
      default: 'pending' 
    },
    
    paymentStatus: { 
      type: String, 
      enum: ['pending', 'initiated', 'paid', 'failed', 'refunded', 'partially_paid', 'partially_refunded'], 
      default: 'pending' 
    },

    /** Online checkout: server time after which unpaid orders may be auto-cancelled (see paymentHoldExpiry.service) */
    paymentHoldExpiresAt: { type: Date, default: null, index: true },

    /** Paid so far (INR) when using advance / multi-capture flows */
    amountPaidInr: { type: Number, default: 0 },
    balanceDueInr: { type: Number, default: 0 },
    
    paymentInfo: { 
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },

    refundHistory: {
      type: [
        {
          refundId: String,
          amountInr: Number,
          amountPaise: Number,
          status: String,
          reason: String,
          createdAt: Date
        }
      ],
      default: []
    },
    
    // For shipment (future use)
    shipmentInfo: {
      trackingNumber: String,
      courier: String,
      shippedAt: Date,
      deliveredAt: Date
    },
    
    // For returns
    returnInfo: {
      requestedAt: Date,
      approvedAt: Date,
      refundAmount: Number,
      refundId: String,
      status: String
    },
    appliedCoupon: {
        code: { type: String },
        discount: { type: Number, default: 0 }
    }
  },
  { timestamps: true }
);

// Generate order ID before saving
orderSchema.pre('save', function() {
  if (!this.orderId) {
    if (typeof crypto.randomUUID === 'function') {
      this.orderId = `ORD-${crypto.randomUUID().replace(/-/g, '').slice(0, 18).toUpperCase()}`;
    } else {
      this.orderId = `ORD-${crypto.randomBytes(10).toString('hex').toUpperCase()}`;
    }
  }
});

orderSchema.index({ userId: 1, createdAt: -1 });
orderSchema.index({ createdAt: -1, orderStatus: 1 });

module.exports = mongoose.model('Order', orderSchema);