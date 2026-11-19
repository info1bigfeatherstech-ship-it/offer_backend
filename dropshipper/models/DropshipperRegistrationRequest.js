'use strict';

const mongoose = require('mongoose');

const REQUEST_STATUSES = [
  'pending_payment',
  'pending_admin',
  'pending_otp',
  'active',
  'expired',
  'rejected',
  'suspended'
];

const dropshipperRegistrationRequestSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    phone: { type: String, required: true, trim: true, index: true },
    whatsappNumber: { type: String, required: true, trim: true },
    businessName: { type: String, default: '', trim: true },
    permanentAddress: { type: String, required: true, trim: true },
    haveShop: { type: Boolean, default: false },
    businessAddress: { type: String, required: true, trim: true },
    deliveryAddress: { type: String, required: true, trim: true },
    sellingPlaceFrom: { type: String, required: true, trim: true },
    sellingZoneCity: { type: String, required: true, trim: true },
    productCategory: { type: String, required: true, trim: true },
    monthlyEstimatedPurchase: { type: Number, required: true },

    idProofUrl: { type: String, default: '' },
    idProofPublicId: { type: String, default: '' },
    businessAddressProofUrl: { type: String, default: '' },
    businessAddressProofPublicId: { type: String, default: '' },

    amountDueInr: { type: Number, required: true, default: 800 },
    amountPaidInr: { type: Number, default: 0 },
    subscriptionYears: { type: Number, default: 1 },

    payment: {
      status: {
        type: String,
        enum: ['pending', 'paid', 'failed'],
        default: 'pending'
      },
      razorpayOrderId: { type: String, default: null, index: true },
      razorpayPaymentId: { type: String, default: null },
      paidAt: { type: Date, default: null }
    },

    status: {
      type: String,
      enum: REQUEST_STATUSES,
      default: 'pending_payment',
      index: true
    },
    adminDecisionNote: { type: String, default: '', trim: true },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    dropshipperId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Dropshipper',
      default: null,
      index: true
    }
  },
  { timestamps: true }
);

dropshipperRegistrationRequestSchema.index({ email: 1, status: 1 });
dropshipperRegistrationRequestSchema.index({ phone: 1, status: 1 });

module.exports = mongoose.model(
  'DropshipperRegistrationRequest',
  dropshipperRegistrationRequestSchema
);
module.exports.REQUEST_STATUSES = REQUEST_STATUSES;
