const mongoose = require('mongoose');
const slugify = require('slugify');

const categorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true
    },

    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      index: true
    },

    description: {
      type: String,
      default: ''
    },

    // Banner / hero background on category listing page
    image: {
      url: { type: String, default: '' },
      publicId: { type: String, default: '' }
    },

    // Square/card art for Top Categories (and similar UI tiles)
    cardImage: {
      url: { type: String, default: '' },
      publicId: { type: String, default: '' }
    },

    // For nested categories (Men → Shoes → Running)
    parent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
      default: null
    },

    // hierarchical depth
    level: {
      type: Number,
      default: 0
    },

    // status: active | inactive
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active'
    },

    order: {
      type: Number,
      default: 0
    }
  },
  { timestamps: true }
);


// ========================
// AUTO SLUG GENERATION
// ========================
categorySchema.pre('validate', function () {
  if (this.name && !this.slug) {
    this.slug = slugify(this.name, { lower: true, strict: true });
  }
});


// ========================
// INDEXES (Performance)
// ========================
categorySchema.index({ name: 'text' });
categorySchema.index({ parent: 1 });
categorySchema.index({ status: 1 });

module.exports = mongoose.model('Category', categorySchema);

