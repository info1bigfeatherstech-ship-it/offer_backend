
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");

const userSchema = new mongoose.Schema(
  {
    // ===== BASIC PROFILE =====
    name: {
      type: String,
      trim: true
    },
    
    email: {
      type: String,
      lowercase: true,
      trim: true,
      index: true,
      unique: true,
      sparse: true
    },

    phone: {
      type: String,
      trim: true,
      index: true,
      unique: true,
      sparse: true
    },

    // ===== PASSWORD =====
    password: {
      type: String,
      minlength: 6,
      select: false
    },

    // ===== GOOGLE AUTH =====
    googleId: {
      type: String,
      index: true,
      sparse: true
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
userSchema.index({ email: 1, phone: 1 }); // Compound index for login lookup
userSchema.index({ registrationMethod: 1 });

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