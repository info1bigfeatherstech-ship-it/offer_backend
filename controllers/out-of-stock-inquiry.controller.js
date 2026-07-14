/**
 * Out-of-stock customer inquiries — public submit + admin list/status.
 */
const mongoose = require('mongoose');
const OutOfStockInquiry = require('../models/OutOfStockInquiry');
const Product = require('../models/Product');
const logger = require('../utils/logger');
const {
  validateInquiryContact,
  isVariantOutOfStock,
} = require('../utils/oosInquiryValidation');

const DUPLICATE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

function sendError(res, err, fallbackMessage) {
  const status = err.statusCode && Number.isFinite(err.statusCode) ? err.statusCode : 500;
  const code = err.code || (status === 400 ? 'BAD_REQUEST' : 'INTERNAL_ERROR');
  const message =
    status === 500 && process.env.NODE_ENV === 'production'
      ? fallbackMessage
      : err.message || fallbackMessage;
  if (status >= 500) {
    logger.error('[oos-inquiry]', { message: err.message, code, stack: err.stack });
  }
  return res.status(status).json({
    success: false,
    code,
    message,
    ...(err.field ? { field: err.field } : {}),
  });
}

function createHttpError(statusCode, code, message, field) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  if (field) err.field = field;
  return err;
}

function pickProductImage(product, variant) {
  const vImgs = Array.isArray(variant?.images) ? variant.images : [];
  const pImgs = Array.isArray(product?.images) ? product.images : [];
  const first = vImgs[0] || pImgs[0];
  if (!first) return null;
  if (typeof first === 'string') return first;
  return first.url || null;
}

function resolveVariantTitle(product, variant) {
  const name = String(product?.name || '').trim();
  const attrs = Array.isArray(variant?.attributes) ? variant.attributes : [];
  const attrLabel = attrs
    .map((a) => String(a?.value || '').trim())
    .filter(Boolean)
    .join(' / ');
  if (name && attrLabel) return `${name} (${attrLabel})`;
  return name || variant?.sku || 'Product';
}

/**
 * POST /api/oos-inquiries
 * Body: { productId, variantId, email, phone } — both contacts required.
 */
exports.submitOutOfStockInquiry = async (req, res) => {
  try {
    const productId = String(req.body?.productId || '').trim();
    const variantId = String(req.body?.variantId || '').trim();

    if (!mongoose.Types.ObjectId.isValid(productId)) {
      throw createHttpError(400, 'INVALID_PRODUCT', 'Valid productId is required', 'productId');
    }
    if (!mongoose.Types.ObjectId.isValid(variantId)) {
      throw createHttpError(400, 'INVALID_VARIANT', 'Valid variantId is required', 'variantId');
    }

    const { email, phone } = validateInquiryContact({
      email: req.body?.email,
      phone: req.body?.phone,
    });

    const product = await Product.findById(productId)
      .select('name slug images variants status')
      .lean();

    if (!product) {
      throw createHttpError(404, 'PRODUCT_NOT_FOUND', 'Product not found');
    }

    const variants = Array.isArray(product.variants) ? product.variants : [];
    const variant = variants.find((v) => String(v._id) === String(variantId));
    if (!variant) {
      throw createHttpError(404, 'VARIANT_NOT_FOUND', 'Variant not found on this product');
    }

    if (!isVariantOutOfStock(variant)) {
      throw createHttpError(
        409,
        'PRODUCT_IN_STOCK',
        'This product is currently in stock. You can add it to cart.',
        'productId'
      );
    }

    const storefront = req.storefront === 'wholesale' ? 'wholesale' : 'ecomm';
    const since = new Date(Date.now() - DUPLICATE_WINDOW_MS);

    const contactOr = [];
    if (email) contactOr.push({ email });
    if (phone) contactOr.push({ phone });

    const existing = await OutOfStockInquiry.findOne({
      productId,
      variantId,
      status: { $in: ['pending', 'notifying'] },
      createdAt: { $gte: since },
      $or: contactOr,
    })
      .select('_id status createdAt')
      .lean();

    if (existing) {
      return res.status(200).json({
        success: true,
        alreadyRegistered: true,
        message: 'You already requested a notification for this product. We will update you when it is back.',
        data: {
          id: existing._id,
          status: existing.status,
          createdAt: existing.createdAt,
        },
      });
    }

    const userId =
      req.userId && mongoose.Types.ObjectId.isValid(String(req.userId))
        ? req.userId
        : null;

    const doc = await OutOfStockInquiry.create({
      productId,
      variantId,
      productSlug: product.slug || null,
      productName: resolveVariantTitle(product, variant),
      variantSku: variant.sku || null,
      productImage: pickProductImage(product, variant),
      email,
      phone,
      userId,
      storefront,
      status: 'pending',
      source: 'pdp',
    });

    return res.status(201).json({
      success: true,
      alreadyRegistered: false,
      message: 'Thanks! We will notify you when this product is back in stock.',
      data: {
        id: doc._id,
        status: doc.status,
        createdAt: doc.createdAt,
      },
    });
  } catch (err) {
    return sendError(res, err, 'Could not submit out-of-stock inquiry');
  }
};

/**
 * GET /api/admin/oos-inquiries
 */
exports.listOutOfStockInquiries = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '20'), 10) || 20));
    const skip = (page - 1) * limit;

    const statusRaw = String(req.query.status || '').trim().toLowerCase();
    const search = String(req.query.search || '').trim();
    const days = Math.min(366, Math.max(1, parseInt(String(req.query.days || '30'), 10) || 30));

    const storefront =
      req.adminScope?.storefront ||
      (req.storefront === 'wholesale' ? 'wholesale' : 'ecomm');

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const filter = {
      storefront,
      createdAt: { $gte: since },
    };

    if (statusRaw && statusRaw !== 'all') {
      if (!['pending', 'notified', 'closed'].includes(statusRaw)) {
        throw createHttpError(400, 'INVALID_STATUS', 'Invalid status filter');
      }
      filter.status = statusRaw;
    }

    if (search) {
      const safe = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(safe, 'i');
      filter.$or = [
        { email: re },
        { phone: re },
        { productName: re },
        { productSlug: re },
        { variantSku: re },
      ];
    }

    const [rows, total] = await Promise.all([
      OutOfStockInquiry.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      OutOfStockInquiry.countDocuments(filter),
    ]);

    const data = rows.map((row) => ({
      id: row._id,
      productId: row.productId,
      variantId: row.variantId,
      productName: row.productName,
      productSlug: row.productSlug,
      variantSku: row.variantSku,
      productImage: row.productImage,
      email: row.email || null,
      phone: row.phone || null,
      status: row.status,
      storefront: row.storefront,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      notifiedAt: row.notifiedAt,
      closedAt: row.closedAt,
      adminNote: row.adminNote || null,
    }));

    return res.json({
      success: true,
      data,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 0,
      },
    });
  } catch (err) {
    return sendError(res, err, 'Could not load out-of-stock inquiries');
  }
};

/**
 * PATCH /api/admin/oos-inquiries/:id/status
 * Body: { status: 'notified'|'closed'|'pending', adminNote? }
 */
exports.updateOutOfStockInquiryStatus = async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw createHttpError(400, 'INVALID_ID', 'Valid inquiry id is required');
    }

    const nextStatus = String(req.body?.status || '').trim().toLowerCase();
    if (!['pending', 'notified', 'closed'].includes(nextStatus)) {
      throw createHttpError(400, 'INVALID_STATUS', 'status must be pending, notified, or closed');
    }

    const adminNoteRaw = req.body?.adminNote;
    const adminNote =
      adminNoteRaw == null
        ? undefined
        : String(adminNoteRaw).trim().slice(0, 500) || null;

    const storefront =
      req.adminScope?.storefront ||
      (req.storefront === 'wholesale' ? 'wholesale' : 'ecomm');

    const doc = await OutOfStockInquiry.findOne({ _id: id, storefront });
    if (!doc) {
      throw createHttpError(404, 'NOT_FOUND', 'Inquiry not found');
    }

    doc.status = nextStatus;
    if (adminNote !== undefined) doc.adminNote = adminNote;
    if (nextStatus === 'notified') doc.notifiedAt = new Date();
    if (nextStatus === 'closed') doc.closedAt = new Date();
    if (nextStatus === 'pending') {
      doc.notifiedAt = null;
      doc.closedAt = null;
    }

    await doc.save();

    return res.json({
      success: true,
      message: 'Inquiry status updated',
      data: {
        id: doc._id,
        status: doc.status,
        notifiedAt: doc.notifiedAt,
        closedAt: doc.closedAt,
        adminNote: doc.adminNote,
        updatedAt: doc.updatedAt,
      },
    });
  } catch (err) {
    return sendError(res, err, 'Could not update inquiry status');
  }
};
