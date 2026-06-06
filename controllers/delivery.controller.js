// controllers/delivery.controller.js
const mongoose = require('mongoose');
const ShiprocketService = require('../utils/shiprocket');
const DeliveryZone = require('../models/delieveryZone');
const Cart = require('../models/cart');
const Product = require('../models/Product');
const { aggregateShipping } = require('../services/checkoutComputation.service');
const logger = require('../utils/logger');

const DEFAULT_ITEM_WEIGHT_KG = 0.5;

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

/** Batch-load shipping weights — avoids N+1 queries (same totals as per-row finds, including 0.5kg fallback). */
async function calculateCartWeightKg(cartItems) {
  const ids = uniqueProductIds(cartItems);
  let products = [];
  if (ids.length) {
    products = await Product.find({ _id: { $in: ids } })
      .select('shipping')
      .lean();
  }
  const byId = new Map(products.map((p) => [String(p._id), p]));

  let totalWeight = 0;
  for (const item of cartItems || []) {
    if (!item?.productId) continue;
    const p = mongoose.isValidObjectId(item.productId)
      ? byId.get(String(item.productId))
      : null;
    const w = Number(p?.shipping?.weight);
    const unit = Number.isFinite(w) && w > 0 ? w : DEFAULT_ITEM_WEIGHT_KG;
    totalWeight += (Number(item.quantity) || 0) * unit;
  }
  return totalWeight;
}

/** Build shipping lines for aggregateShipping using one query for all cart products. */
async function buildShippingLinesFromCartItems(cartItems) {
  const ids = uniqueProductIds(cartItems);
  if (!ids.length) return [];

  const products = await Product.find({ _id: { $in: ids } })
    .select('shipping')
    .lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));

  const lines = [];
  for (const it of cartItems) {
    const p = byId.get(String(it.productId));
    if (p) lines.push({ product: p, quantity: Number(it.quantity) || 0 });
  }
  return lines;
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
      totalWeight = await calculateCartWeightKg(cartDoc.items);
      const lines = await buildShippingLinesFromCartItems(cartDoc.items);
      if (lines.length) dims = aggregateShipping(lines);
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

// ========== ADMIN FUNCTIONS ==========
exports.addDeliveryZone = async (req, res) => {
  try {
    const { name, pincodes, baseCharge, perKgCharge, freeDeliveryAbove, estimatedDays } = req.body;

    const deliveryZone = new DeliveryZone({
      name,
      pincodes,
      baseCharge,
      perKgCharge,
      freeDeliveryAbove,
      estimatedDays
    });

    await deliveryZone.save();

    return res.status(201).json({
      success: true,
      message: 'Delivery zone added successfully',
      deliveryZone
    });
  } catch (error) {
    logger.error('Add delivery zone error:', { message: error.message, stack: error.stack });
    return res.status(500).json({
      success: false,
      message: 'Error adding delivery zone',
      error: error.message
    });
  }
};

exports.getDeliveryZones = async (req, res) => {
  try {
    const zones = await DeliveryZone.find({ isActive: true });
    return res.json({
      success: true,
      zones
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Error fetching delivery zones',
      error: error.message
    });
  }
};

exports.updateDeliveryZone = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const zone = await DeliveryZone.findByIdAndUpdate(id, updates, { new: true });
    if (!zone) {
      return res.status(404).json({
        success: false,
        message: 'Delivery zone not found'
      });
    }

    return res.json({
      success: true,
      message: 'Delivery zone updated',
      deliveryZone: zone
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Error updating delivery zone',
      error: error.message
    });
  }
};
