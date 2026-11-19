'use strict';

const mongoose = require('mongoose');

/**
 * Singleton dropshipper subscription settings.
 * subscriptionYears is always 1 (enforced in the auth service).
 */
const dropshipperSettingsSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      default: 'default'
    },
    subscriptionAmountInr: {
      type: Number,
      required: true,
      default: 800,
      min: 0
    },
    subscriptionYears: {
      type: Number,
      required: true,
      default: 1
    },
    registrationOpen: {
      type: Boolean,
      default: true
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('DropshipperSettings', dropshipperSettingsSchema);
