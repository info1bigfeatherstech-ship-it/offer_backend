// models/Order.js
const mongoose = require('mongoose');
const { generateOrderId } = require('../utils/orderId');

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

    /** Checkout channel at order place (for ID prefix + admin scope) */
    storefront: { type: String, enum: ['ecomm', 'wholesale'], default: 'ecomm' },
    
    orderStatus: { 
      type: String, 
      enum: ['pending', 'confirmed', 'processing', 'shipped', 'out_for_delivery', 'delivered', 'cancelled', 'return_requested', 'payment_failed', 'rto'], 
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
      shipmentId: String,
      /** Shiprocket channel order id (numeric) — used for cancel API */
      shiprocketOrderId: { type: String, default: null },
      awbCode: String,
      trackingNumber: String,
      courier: String,
      assignedCourierId: { type: String, default: null },
      /** Set when Ship Now assigns a different courier because checkout quote was inactive/blocked */
      courierAssignNote: { type: String, default: null },
      courierSubstitutedFromId: { type: Number, default: null },
      courierSubstitutedFromName: { type: String, default: null },
      providerStatus: String,
      estimatedDelivery: String,
      labelUrl: String,
      /** Shiprocket handover manifest PDF URL */
      manifestUrl: { type: String, default: null },
      manifestGeneratedAt: Date,
      fulfillmentArtifactAwb: { type: String, default: null },
      fulfillmentLabelAwb: { type: String, default: null },
      fulfillmentManifestAwb: { type: String, default: null },
      shippedAt: Date,
      outForDeliveryAt: Date,
      deliveredAt: Date,
      /** Scheduled pickup date YYYY-MM-DD (Shiprocket generate/pickup) */
      pickupDate: { type: String, default: null },
      pickupScheduledAt: Date,
      /** Shiprocket pickup batch id (panel: SRPID-48421432) */
      shiprocketPickupId: { type: String, default: null },
      lastSyncAt: Date,
      lastSyncSource: String,
      lastError: String,
      lastPickupError: { type: String, default: null },
      createAttemptCount: { type: Number, default: 0 },
      rawEvents: { type: [mongoose.Schema.Types.Mixed], default: [] }
    },

    /** Cached shipment ops view (list/detail actions + provider state classification) */
    shipmentOps: {
      type: mongoose.Schema.Types.Mixed,
      default: null
    },
    
    // For returns
    returnInfo: {
      reasonType: {
        type: String,
        enum: ['damaged', 'wrong_item', null],
        default: null
      },
      reasonMessage: { type: String, default: null },
      proofs: {
        type: [
          {
            kind: { type: String, enum: ['image', 'video'], required: true },
            url: { type: String, required: true },
            publicId: { type: String, default: null }
          }
        ],
        default: []
      },
      requestedAt: Date,
      approvedAt: Date,
      approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', default: null },
      rejectedAt: Date,
      rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', default: null },
      decisionReason: { type: String, default: null },
      reverseShipmentId: { type: String, default: null },
      reverseAwbCode: { type: String, default: null },
      reverseTrackingNumber: { type: String, default: null },
      reverseCourier: { type: String, default: null },
      reverseProviderStatus: { type: String, default: null },
      reverseEvents: { type: [mongoose.Schema.Types.Mixed], default: [] },
      reverseLastSyncAt: Date,
      reverseLastError: { type: String, default: null },
      refundInitiatedAt: Date,
      refundAmount: Number,
      refundId: String,
      status: String,
      /** `cancellation` = order cancelled before delivery; `product_return` = post-delivery return flow */
      refundContext: { type: String, enum: ['cancellation', 'product_return', null], default: null },
      chat: {
        type: [
          {
            sender: { type: String, enum: ['user', 'admin'], required: true },
            message: { type: String, required: true },
            createdAt: { type: Date, default: Date.now }
          }
        ],
        default: []
      },
      userLastRead: { type: Date, default: null },
      adminLastRead: { type: Date, default: null },

      /** RTO management (admin RTO tab — does not affect product-return flow) */
      rtoStatus: {
        type: String,
        enum: ['pending', 'refunded', 'refund_failed', 'refund_rejected', 'resolved', null],
        default: null
      },
      rtoRefundAmount: { type: Number, default: null },
      rtoRefundId: { type: String, default: null },
      rtoRefundedAt: { type: Date, default: null },
      rtoResolvedAt: { type: Date, default: null },
      rtoResolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', default: null },
      rtoRejectedAt: { type: Date, default: null },
      rtoRejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', default: null },
      rtoRejectionNote: { type: String, default: null },
      /** Exact Shiprocket carrier label at classification time */
      rtoShiprocketReason: { type: String, default: null },
      rtoReasonCategory: {
        type: String,
        enum: ['customer', 'courier', 'unknown', null],
        default: null
      },
      rtoRefundError: { type: String, default: null },
      rtoDeductions: {
        forwardShipping: { type: Number, default: 0 },
        rtoShipping: { type: Number, default: 0 },
        platformFee: { type: Number, default: 0 },
        platformFeePercent: { type: Number, default: 0 }
      },
      rtoHistory: {
        type: [
          {
            action: { type: String, required: true },
            note: { type: String, default: null },
            performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', default: null },
            createdAt: { type: Date, default: Date.now },
            metadata: { type: mongoose.Schema.Types.Mixed, default: null }
          }
        ],
        default: []
      }
    },
    appliedCoupon: {
        code: { type: String },
        discount: { type: Number, default: 0 }
    },

    /** Snapshot from checkout quote (Shiprocket serviceability) — quote courier at order time */
    shippingSnapshot: {
      courierName: { type: String, default: null },
      estimatedDays: { type: String, default: null },
      courierCompanyId: { type: Number, default: null }
    },

    /** Package weight/dims sent to Shiprocket at checkout (frozen at order place) */
    shippingWeightSnapshot: {
      totalWeightKg: { type: Number, default: null },
      totalDimWeightKg: { type: Number, default: null },
      dims: {
        lengthCm: { type: Number, default: null },
        widthCm: { type: Number, default: null },
        heightCm: { type: Number, default: null }
      },
      lines: {
        type: [
          {
            productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
            variantId: { type: mongoose.Schema.Types.ObjectId },
            productName: { type: String, default: null },
            sku: { type: String, default: null },
            quantity: { type: Number, default: 0 },
            unitWeightKg: { type: Number, default: null },
            lineWeightKg: { type: Number, default: null },
            lengthCm: { type: Number, default: null },
            widthCm: { type: Number, default: null },
            heightCm: { type: Number, default: null },
            unitDimWeightKg: { type: Number, default: null },
            lineDimWeightKg: { type: Number, default: null }
          }
        ],
        default: []
      },
      /** checkout | catalog_fallback (legacy display only) */
      source: { type: String, default: 'checkout' }
    }
  },
  { timestamps: true }
);

// Generate order ID before saving (fallback if controller did not set orderId)
orderSchema.pre('save', function() {
  if (!this.orderId) {
    this.orderId = generateOrderId({
      storefront: this.storefront,
      userType: this.userType
    });
  }
});

orderSchema.index({ userId: 1, createdAt: -1 });
orderSchema.index({ createdAt: -1, orderStatus: 1 });

module.exports = mongoose.model('Order', orderSchema);