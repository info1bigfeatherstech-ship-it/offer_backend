
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");

const userSchema = new mongoose.Schema(
  {
    // ===== BASIC PROFILE =====
    name: {
      type: String,
      trim: true
    },
    
    /**
     * Unique via partial index below — NOT field-level unique/sparse.
     * Sparse unique still indexes `null` and allows only one phone-only user.
     */
    email: {
      type: String,
      lowercase: true,
      trim: true
    },

    phone: {
      type: String,
      trim: true
    },

    // ===== PASSWORD =====
    password: {
      type: String,
      minlength: 6,
      select: false
    },

    // ===== GOOGLE AUTH =====
    /** Unique via partial index — omit when unset (never store null). */
    googleId: {
      type: String
    },

    // =====  REFRESH TOKEN STORAGE =====
    refreshTokens: [
      {
        token: {
          type: String,
          required: true,
          select: false
        },
        createdAt: {
          type: Date,
          default: Date.now
        },
        expiresAt: {
          type: Date
        },
        deviceInfo: {
          type: String,
             default: 'Unknown'
        },
        /** Short-lived: allows one concurrent/replayed refresh after rotation (race-safe). */
        previousToken: {
          type: String,
          select: false
        },
        previousTokenValidUntil: {
          type: Date,
          select: false
        }
      }
    ],

    // ===== VERIFICATION FLAGS =====
    isEmailVerified: {
      type: Boolean,
      default: false
    },

    isPhoneVerified: {
      type: Boolean,
      default: false
    },

    // ===== OTP STORAGE =====
    emailVerificationOTP: {
      type: String,
      select: false
    },

    emailVerificationOTPExpires: {
      type: Date,
      select: false
    },

    phoneVerificationOTP: {
      type: String,
      select: false
    },

    phoneVerificationOTPExpires: {
      type: Date,
      select: false
    },

    // ===== PASSWORD RESET OTP =====
    // Kept for wholesaleFrontend legacy OTP forgot-password flow.
    // Ecomm Option D uses Redis-backed short-lived reset tokens instead.
    passwordResetOTP: {
      type: String,
      select: false
    },

    passwordResetOTPExpires: {
      type: Date,
      select: false
    },

    // ===== CONTACT CHANGE OTP FLOW =====
    contactChangeField: {
      type: String,
      enum: ['email', 'phone'],
      select: false
    },
    contactChangeValue: {
      type: String,
      trim: true,
      select: false
    },
    contactChangeOTP: {
      type: String,
      select: false
    },
    contactChangeOTPExpires: {
      type: Date,
      select: false
    },
    contactChangeOTPAttempts: {
      type: Number,
      default: 0,
      select: false
    },

    // NEW FIELD: Which method user used to register (phone/email/google)
    registrationMethod: {
      type: String,
      enum: ['phone', 'email', 'google'],
      default: null
    },

    //  NEW FIELD: Track if user completed full registration
    isProfileComplete: {
      type: Boolean,
      default: false
    },

    //  NEW FIELD: Last login method
    lastLoginMethod: {
      type: String,
      enum: ['phone', 'email', 'google', 'otp'],
      default: null
    },

    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active"
    },

    userType: {
      type: String,
      enum: ["user", "wholesaler", "admin"],
      default: "user"
    },

    role: {
      type: String,
      enum: [
        "user",
        "admin",
        "product_manager",
        "order_manager",
        "marketing_manager",
        "wholesaler"
      ],
      default: "user"
    },

    /**
     * Admin operational data scope (orders/users/carts/wishlists/analytics).
     * Backward-compatible default is ecomm only.
     */
    allowedStorefronts: {
      type: [String],
      enum: ["ecomm", "wholesale"],
      default: ["ecomm"]
    }
  },
  { timestamps: true }
);

// ================= INDEXES =================
// Partial unique: many users may omit email/phone; only real non-empty values collide.
userSchema.index(
  { email: 1 },
  {
    unique: true,
    name: 'email_unique_partial',
    partialFilterExpression: { email: { $type: 'string', $gt: '' } }
  }
);
userSchema.index(
  { phone: 1 },
  {
    unique: true,
    name: 'phone_unique_partial',
    partialFilterExpression: { phone: { $type: 'string', $gt: '' } }
  }
);
userSchema.index(
  { googleId: 1 },
  {
    unique: true,
    name: 'googleId_unique_partial',
    partialFilterExpression: { googleId: { $type: 'string', $gt: '' } }
  }
);
userSchema.index({ email: 1, phone: 1 }); // Compound index for login lookup
userSchema.index({ registrationMethod: 1 });

/**
 * Never persist empty/null on unique contact fields — otherwise a legacy
 * unique/sparse `email_1` (or BSON null) blocks the 2nd phone-only register.
 */
userSchema.pre('save', function clearEmptyUniqueContacts() {
  for (const path of ['email', 'phone', 'googleId']) {
    const val = this.get(path);
    if (val == null || (typeof val === 'string' && !String(val).trim())) {
      this.set(path, undefined);
      if (this._doc && Object.prototype.hasOwnProperty.call(this._doc, path)) {
        delete this._doc[path];
      }
    }
  }
});

// ================= PASSWORD HASH =================
userSchema.pre("save", async function () {
  if (!this.isModified("password") || !this.password) return;
  if (this.password.startsWith("$2b$")) return; // already hashed

  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
});

// ================= PASSWORD COMPARE =================
userSchema.methods.comparePassword = async function (enteredPassword) {
  if (!this.password) throw new Error("No password set for this user");
  return await bcrypt.compare(enteredPassword, this.password);
};

// ================= HELPER: Find user by email or phone =================
userSchema.statics.findByIdentifier = async function(identifier) {
  return await this.findOne({
    $or: [
      { email: identifier.toLowerCase() },
      { phone: identifier }
    ]
  });
};

module.exports = mongoose.model("User", userSchema);