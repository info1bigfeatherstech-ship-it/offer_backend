// controllers/delivery.controller.js
const mongoose = require('mongoose');
const ShiprocketService = require('../utils/shiprocket');
const Cart = require('../models/cart');
const Product = require('../models/Product');
const { aggregateShipping } = require('../services/checkoutComputation.service');
const {
  resolveVariantShipping,
  unitWeightKgFromResolvedShipping,
  DEFAULT_UNIT_WEIGHT_KG
} = require('../utils/variantCatalogFields');
const logger = require('../utils/logger');

function uniqueProductIds(cartItems) {
  const ids = [];
  const seen = new Set();
  for (const item of cartItems || []) {
    const id = item?.productId;
    if (!id || !mongoose.isValidObjectId(id)) continue;
    const s = String(id);
    if (seen.has(s)) continue;
    seen.add(s);
    ids.push(id);
  }
  return ids;
}

function findVariantOnProduct(product, variantId) {
  if (!product?.variants?.length || variantId == null) return product?.variants?.[0] || null;
  return product.variants.find((v) => String(v._id) === String(variantId)) || null;
}

/** Batch-load products and resolve per-line shipping (variant ?? product). */
async function buildShippingLinesFromCartItems(cartItems) {
  const ids = uniqueProductIds(cartItems);
  if (!ids.length) return [];

  const products = await Product.find({ _id: { $in: ids } })
    .select('shipping variants')
    .lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));

  const lines = [];
  for (const it of cartItems || []) {
    const p = byId.get(String(it.productId));
    if (!p) continue;
    const variant = findVariantOnProduct(p, it.variantId);
    lines.push({
      product: p,
      variant,
      quantity: Number(it.quantity) || 0,
      resolvedShipping: resolveVariantShipping(variant, p)
    });
  }
  return lines;
}

async function calculateCartWeightKg(cartItems) {
  const lines = await buildShippingLinesFromCartItems(cartItems);
  if (!lines.length) return DEFAULT_UNIT_WEIGHT_KG;

  let totalWeight = 0;
  for (const line of lines) {
    const w = unitWeightKgFromResolvedShipping(
      line.resolvedShipping || resolveVariantShipping(line.variant, line.product)
    );
    totalWeight += (Number(line.quantity) || 0) * w;
  }
  return Math.max(0.05, totalWeight);
}

// ========== PRODUCTION VERSION ==========
exports.checkDeliveryAvailability = async (req, res) => {
  try {
    const { pincode, cartId } = req.body || {};
    const userId = req.userId;

    if (!pincode || !/^\d{6}$/.test(pincode)) {
      return res.status(400).json({
        success: false,
        message: 'Valid 6-digit pincode is required'
      });
    }

    let totalWeight = 1;
    let dims = { lengthCm: 1, widthCm: 1, heightCm: 1 };

    const cartDoc = cartId
      ? await Cart.findById(cartId)
      : userId
        ? await Cart.findOne({ userId })
        : null;

    if (cartDoc?.items?.length) {
      const lines = await buildShippingLinesFromCartItems(cartDoc.items);
      if (lines.length) {
        totalWeight = lines.reduce((sum, line) => {
          const w = unitWeightKgFromResolvedShipping(
            line.resolvedShipping || resolveVariantShipping(line.variant, line.product)
          );
          return sum + (Number(line.quantity) || 0) * w;
        }, 0);
        totalWeight = Math.max(0.05, totalWeight);
        dims = aggregateShipping(lines);
      }
    }

    const result = await ShiprocketService.checkDeliveryAvailability(pincode, {
      weightKg: totalWeight,
      lengthCm: dims.lengthCm,
      widthCm: dims.widthCm,
      heightCm: dims.heightCm
    });

    return res.status(200).json({
      success: true,
      isDeliverable: result.isDeliverable,
      estimatedDays: result.estimatedDays,
      courierName: result.courierName,
      message: result.message,
      pincode: pincode
    });
  } catch (error) {
    logger.error('Delivery check error:', { message: error.message, stack: error.stack });
    return res.status(500).json({
      success: false,
      message: 'Error checking delivery availability',
      error: error.message
    });
  }
};

exports.getDeliveryCharges = async (req, res) => {
  try {
    const { pincode } = req.params;
    const { weight = 1 } = req.query;

    if (!pincode || !/^\d{6}$/.test(pincode)) {
      return res.status(400).json({
        success: false,
        message: 'Valid 6-digit pincode is required'
      });
    }

    const result = await ShiprocketService.getDeliveryCharges(pincode, parseFloat(weight));

    return res.status(200).json({
      success: true,
      isServiceable: result.isDeliverable,
      deliveryCharges: result.deliveryCharges,
      estimatedDays: result.estimatedDays,
      courierName: result.courierName
    });
  } catch (error) {
    logger.error('Get delivery charges error:', { message: error.message, stack: error.stack });
    return res.status(500).json({
      success: false,
      message: 'Error fetching delivery charges',
      error: error.message
    });
  }
};
