const mongoose = require('mongoose');

const ENQUIRY_TYPES = ['custom', 'bulk'];
const STATUS_ENUM = ['pending', 'contacted', 'quoted', 'closed', 'converted'];
const STOREFRONTS = ['ecomm', 'wholesale'];
const FILE_KINDS = ['logo', 'reference', 'business_card'];

const fileAssetSchema = new mongoose.Schema(
  {
    url: { type: String, required: true, trim: true, maxlength: 800 },
    publicId: { type: String, required: true, trim: true, maxlength: 400 },
    originalName: { type: String, trim: true, maxlength: 200, default: null },
    mimeType: { type: String, trim: true, maxlength: 100, default: null },
    sizeBytes: { type: Number, min: 0, default: null },
    kind: { type: String, enum: FILE_KINDS, required: true },
  },
  { _id: false }
);

const corporateGiftEnquirySchema = new mongoose.Schema(
  {
    enquiryType: {
      type: String,
      enum: ENQUIRY_TYPES,
      required: true,
      index: true,
    },

    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: 254,
      default: null,
      index: true,
    },
    phone: { type: String, required: true, trim: true, maxlength: 15, index: true },
    organizationName: { type: String, trim: true, maxlength: 160, default: null },
    city: { type: String, trim: true, maxlength: 120, default: null },

    occasion: { type: String, trim: true, maxlength: 120, default: null },
    giftCategory: { type: String, trim: true, maxlength: 120, default: null },
    quantity: { type: Number, min: 1, max: 100000, default: null },
    targetDeliveryDate: { type: Date, default: null },
    message: { type: String, trim: true, maxlength: 2000, default: null },

    businessType: { type: String, trim: true, maxlength: 120, default: null },
    volumeOrder: { type: Number, min: 1, max: 100000, default: null },

    logos: { type: [fileAssetSchema], default: [] },
    referencePhotos: { type: [fileAssetSchema], default: [] },
    businessCard: { type: fileAssetSchema, default: null },

    storefront: {
      type: String,
      enum: STOREFRONTS,
      default: 'ecomm',
      index: true,
    },
    source: {
      type: String,
      enum: ['gift_page', 'contact'],
      default: 'gift_page',
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },

    status: {
      type: String,
      enum: STATUS_ENUM,
      default: 'pending',
      index: true,
    },
    adminNote: { type: String, trim: true, maxlength: 500, default: null },
    convertedOrderId: { type: String, trim: true, maxlength: 80, default: null },
    contactedAt: { type: Date, default: null },
    quotedAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
    convertedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

corporateGiftEnquirySchema.index({ createdAt: -1 });
corporateGiftEnquirySchema.index({ storefront: 1, status: 1, createdAt: -1 });
corporateGiftEnquirySchema.index({
  phone: 1,
  enquiryType: 1,
  status: 1,
  createdAt: -1,
});

module.exports = mongoose.model('CorporateGiftEnquiry', corporateGiftEnquirySchema);
module.exports.ENQUIRY_TYPES = ENQUIRY_TYPES;
module.exports.STATUS_ENUM = STATUS_ENUM;
module.exports.OPEN_STATUSES = ['pending', 'contacted', 'quoted'];
