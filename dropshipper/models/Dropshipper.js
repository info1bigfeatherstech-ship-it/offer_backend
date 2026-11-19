'use strict';

const mongoose = require('mongoose');

const ACCOUNT_STATUSES = [
  'pending_payment',
  'pending_admin',
  'pending_otp',
  'active',
  'expired',
  'rejected',
  'suspended'
];

/** Statuses that still occupy an email/phone (rejected can re-apply). */
const BLOCKING_ACCOUNT_STATUSES = ['pending_otp', 'active', 'expired', 'suspended'];

const dropshipperSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    phone: { type: String, required: true, trim: true },
    whatsappNumber: { type: String, required: true, trim: true },
    businessName: { type: String, default: '', trim: true },
    permanentAddress: { type: String, default: '', trim: true },
    haveShop: { type: Boolean, default: false },
    businessAddress: { type: String, default: '', trim: true },
    deliveryAddress: { type: String, default: '', trim: true },
    sellingPlaceFrom: { type: String, default: '', trim: true },
    sellingZoneCity: { type: String, default: '', trim: true },
    productCategory: { type: String, default: '', trim: true },
    monthlyEstimatedPurchase: { type: Number, default: null },

    registrationRequestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'DropshipperRegistrationRequest',
      default: null,
      index: true
    },

    status: {
      type: String,
      enum: ACCOUNT_STATUSES,
      default: 'pending_otp',
      index: true
    },

    password: { type: String, select: false },

    subscriptionYears: { type: Number, default: 1 },
    subscriptionStartedAt: { type: Date, default: null },
    subscriptionExpiresAt: { type: Date, default: null, index: true },

    activationOtpHash: { type: String, select: false },
    activationOtpExpiresAt: { type: Date, default: null },
    activationOtpAttempts: { type: Number, default: 0 },
    activationOtpSentAt: { type: Date, default: null },

    refreshTokens: {
      type: [
        {
          tokenHash: { type: String, required: true },
          expiresAt: { type: Date, default: null },
          createdAt: { type: Date, default: Date.now }
        }
      ],
      select: false,
      default: []
    },

    renewalPending: {
      razorpayOrderId: { type: String, default: null },
      amountInr: { type: Number, default: null },
      amountPaise: { type: Number, default: null },
      createdAt: { type: Date, default: null }
    },
    renewalHistory: {
      type: [
        {
          razorpayOrderId: { type: String },
          razorpayPaymentId: { type: String },
          amountInr: { type: Number },
          paidAt: { type: Date },
          previousExpiresAt: { type: Date, default: null },
          nextExpiresAt: { type: Date }
        }
      ],
      default: []
    }
  },
  { timestamps: true }
);

dropshipperSchema.index(
  { email: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: BLOCKING_ACCOUNT_STATUSES } }
  }
);
dropshipperSchema.index(
  { phone: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: BLOCKING_ACCOUNT_STATUSES } }
  }
);

module.exports = mongoose.model('Dropshipper', dropshipperSchema);
module.exports.ACCOUNT_STATUSES = ACCOUNT_STATUSES;
module.exports.BLOCKING_ACCOUNT_STATUSES = BLOCKING_ACCOUNT_STATUSES;
