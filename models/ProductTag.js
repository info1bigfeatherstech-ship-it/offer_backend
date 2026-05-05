const mongoose = require("mongoose");

const productTagSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },

    tags: {
      type: [String],
      enum: ["on-sale", "today-arrival"],
      default: []
    }
  },
  { timestamps: true }
);
module.exports = mongoose.model("ProductTag", productTagSchema);