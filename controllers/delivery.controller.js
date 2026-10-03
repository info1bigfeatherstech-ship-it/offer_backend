// controllers/delivery.controller.js
const mongoose = require('mongoose');
const {
  checkDeliveryAvailabilityForActiveProvider,
  getDeliveryChargesForActiveProvider
} = require('../services/shippingQuote.service');
const Cart = require('../models/cart');
const Product = require('../models/Product');
const { aggregateShipping } = require('../services/checkoutComputation.service');
const {
  resolveVariantShipping,
  unitWeightKgFromResolvedShipping,
  DEFAULT_UNIT_WEIGHT_KG
} = require('../utils/variantCatalogFields');
const logger = require('../utils/logger');
const { findCartForStorefront } = require('../services/cartStorefront.service');
const { normalizeCustomerStorefront } = require('../utils/customerStorefrontScope');

const MAX_CLIENT_CART_ITEMS = 50;
const MAX_LINE_QTY = 999;

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

/**
 * Sanitize guest/client-provided cart lines for weight/dims only.
 * Never trusts price or other fields from the client.
 */
function sanitizeClientCartItems(rawItems) {
  if (!Array.isArray(rawItems) || !rawItems.length) return [];

  const out = [];
  for (const it of rawItems.slice(0, MAX_CLIENT_CART_ITEMS)) {
    const productId = it?.productId?._id || it?.productId;
    if (!productId || !mongoose.isValidObjectId(productId)) continue;

    let variantId = it?.variantId?._id || it?.variantId || null;
    if (variantId != null && !mongoose.isValidObjectId(variantId)) {
      variantId = null;
    }

    const quantity = Math.min(
      MAX_LINE_QTY,
      Math.max(1, Math.floor(Number(it?.quantity) || 1))
    );

    out.push({
      productId: String(productId),
      variantId: variantId != null ? String(variantId) : null,
      quantity
    });
  }
  return out;
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
    const { pincode, cartId, items: clientItems } = req.body || {};
    const userId = req.userId;

    if (!pincode || !/^\d{6}$/.test(pincode)) {
      return res.status(400).json({
        success: false,
        message: 'Valid 6-digit pincode is required'
      });
    }

    let totalWeight = 1;
    let dims = { lengthCm: 1, widthCm: 1, heightCm: 1 };

    // Prefer server cart (logged-in / cartId). Guests fall back to sanitized items[].
    let cartItems = null;
    if (cartId && mongoose.isValidObjectId(cartId)) {
      const cartDoc = await Cart.findById(cartId).select('items').lean();
      if (cartDoc?.items?.length) cartItems = cartDoc.items;
    } else if (userId) {
      const cartDoc = await findCartForStorefront(
        userId,
        normalizeCustomerStorefront(req.storefront)
      );
      if (cartDoc?.items?.length) cartItems = cartDoc.items;
    }

    if (!cartItems?.length) {
      const sanitized = sanitizeClientCartItems(clientItems);
      if (sanitized.length) cartItems = sanitized;
    }

    if (cartItems?.length) {
      const lines = await buildShippingLinesFromCartItems(cartItems);
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

    const result = await checkDeliveryAvailabilityForActiveProvider(pincode, {
      weightKg: totalWeight,
      lengthCm: dims.lengthCm,
      widthCm: dims.widthCm,
      heightCm: dims.heightCm,
      storefront: req.storefront || 'ecomm'
    });

    return res.status(200).json({
      success: true,
      isDeliverable: result.isDeliverable,
      estimatedDays: result.estimatedDays,
      courierName: result.courierName,
      message: result.message,
      pincode: pincode,
      shippingProvider: result.shippingProvider || result.provider || null
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

    const result = await getDeliveryChargesForActiveProvider(pincode, parseFloat(weight), {
      storefront: req.storefront || 'ecomm'
    });

    return res.status(200).json({
      success: true,
      isServiceable: result.isDeliverable,
      deliveryCharges: result.deliveryCharges,
      estimatedDays: result.estimatedDays,
      courierName: result.courierName,
      shippingProvider: result.shippingProvider || result.provider || null
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
