const Product = require("../models/Product");
const ProductTag = require("../models/ProductTag");

async function updateProductTagController(req, res) {
  try {
    const { slugs, flagType, value } = req.body;
    console.log(`Received request to update flag '${flagType}' to '${value}' for products: ${slugs.join(", ")}`);

    if (!Array.isArray(slugs) || slugs.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Slugs are required",
      });
    }

    if (!flagType) {
      return res.status(400).json({
        success: false,
        message: "flagType is required",
      });
    }

    const CONTROLLED_FLAGS = ["today-arrival", "on-sale"];

    if (!CONTROLLED_FLAGS.includes(flagType)) {
      return res.status(400).json({
        success: false,
        message: "Invalid flagType",
      });
    }

    const products = await Product.find({
      slug: { $in: slugs },
    }).select("_id");

    const results = await Promise.all(
      products.map(async (product) => {
        const existing = await ProductTag.findOne({
          product: product._id,
        });

        let updatedTags = existing?.tags || [];

        if (value) {
          // ✅ ADD flag
          if (!updatedTags.includes(flagType)) {
            updatedTags.push(flagType);
          }
        } else {
          // ❌ REMOVE flag
          updatedTags = updatedTags.filter(tag => tag !== flagType);
        }

        const updatedDoc = await ProductTag.findOneAndUpdate(
          { product: product._id },
          { $set: { tags: updatedTags } },
          { new: true, upsert: true }
        );

        return updatedDoc;
      })
    );

    return res.status(200).json({
      success: true,
      message: "Flag updated successfully",
      updatedCount: results.length,
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
}

module.exports = updateProductTagController;