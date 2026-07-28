const mongoose = require('mongoose');

const wholesalerDetailsSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: false,
      default: null
    },
    fullName: {
      type: String,
      required: true,
      trim: true
    },
    whatsappNumber: {
      type: String,
      required: true
    },
    mobileNumber: {
      type: String,
      required: true
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true
    },

    /**
     * Business / KYC fields — optional until phase-2 (complete-details) after owner approval.
     * Legacy one-shot applications still store them at create time.
     */
    permanentAddress: {
      type: String,
      default: '',
      trim: true
    },
    haveShop: {
      type: Boolean,
      default: false
    },
    businessAddress: {
      type: String,
      default: '',
      trim: true
    },
    deliveryAddress: {
      type: String,
      default: '',
      trim: true
    },
    sellingPlaceFrom: {
      type: String,
      default: '',
      trim: true
    },
    sellingZoneCity: {
      type: String,
      default: '',
      trim: true
    },
    productCategory: {
      type: String,
      default: '',
      trim: true
    },
    monthlyEstimatedPurchase: {
      type: Number,
      default: null
    },
    idProofUpload: {
      type: String,
      default: ''
    },
    businessAddressProofUpload: {
      type: String,
      default: ''
    },

    /**
     * Set when phase-2 KYC/details were submitted (or at create for legacy full applications).
     * Null = basic interest only; activation OTP requires details to be complete.
     */
    detailsSubmittedAt: {
      type: Date,
      default: null,
      index: true
    },

    registrationFeeAmount: {
      type: Number,
      default: 1200
    },
    registrationPaymentStatus: {
      type: String,
      enum: ['not_required', 'pending', 'created', 'paid', 'failed'],
      default: 'pending',
      index: true
    },
    registrationRazorpayOrderId: {
      type: String,
      default: null
    },
    registrationRazorpayPaymentId: {
      type: String,
      default: null
    },
    registrationPaymentInitiatedAt: {
      type: Date,
      default: null
    },
    registrationPaidAt: {
      type: Date,
      default: null
    },
    registrationPaymentMeta: {
      type: mongoose.Schema.Types.Mixed,
      default: null
    },

    isApproved: {
      type: Boolean,
      default: false
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'activated'],
      default: 'pending',
      index: true
    },
    reviewReason: {
      type: String,
      default: ''
    },
    reviewedAt: {
      type: Date,
      default: null
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    linkedUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    activationOtpHash: {
      type: String,
      default: null,
      select: false
    },
    activationOtpExpiresAt: {
      type: Date,
      default: null
    },
    activationOtpSentAt: {
      type: Date,
      default: null
    },
    activationOtpAttempts: {
      type: Number,
      default: 0
    },
    activatedAt: {
      type: Date,
      default: null
    },
    /** Incremented when admin generates a new owner review link; token must match this version. */
    ownerReviewLinkVersion: {
      type: Number,
      default: 0,
      min: 0
    },
    ownerNotifiedAt: {
      type: Date,
      default: null
    },
    ownerNotifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    }
  },
  { timestamps: true }
);

wholesalerDetailsSchema.index({ mobileNumber: 1, status: 1 });
wholesalerDetailsSchema.index({ email: 1, status: 1 });

module.exports = mongoose.model('WholesalerDetails', wholesalerDetailsSchema);
