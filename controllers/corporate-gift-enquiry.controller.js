/**
 * Corporate / customise-gift enquiries — public submit + admin list/detail/status.
 */

const mongoose = require('mongoose');
const CorporateGiftEnquiry = require('../models/CorporateGiftEnquiry');
const logger = require('../utils/logger');
const {
  validateGiftEnquiryPayload,
  parseAdminStatus,
  parseAdminNote,
  DUPLICATE_WINDOW_MS,
  createHttpError,
  ENQUIRY_TYPES,
  STATUS_ENUM,
  OPEN_STATUSES,
} = require('../utils/corporateGiftEnquiryValidation');
const {
  pickEnquiryFiles,
  validateEnquiryFiles,
  uploadEnquiryAssets,
  rollbackUploads,
} = require('../services/corporateGiftEnquiryUpload.service');
const { enqueueGiftEnquiryEmails } = require('../services/corporateGiftEnquiryEmail.service');

function sendError(res, err, fallbackMessage) {
  const status = err.statusCode && Number.isFinite(err.statusCode) ? err.statusCode : 500;
  const code = err.code || (status === 400 ? 'BAD_REQUEST' : 'INTERNAL_ERROR');
  const message =
    status === 500 && process.env.NODE_ENV === 'production'
      ? fallbackMessage
      : err.message || fallbackMessage;
  if (status >= 500) {
    logger.error('[gift-enquiry]', { message: err.message, code, stack: err.stack });
  }
  return res.status(status).json({
    success: false,
    code,
    message,
    ...(err.field ? { field: err.field } : {}),
  });
}

function resolveStorefront(req) {
  if (req.adminScope?.storefront === 'wholesale') return 'wholesale';
  return req.storefront === 'wholesale' ? 'wholesale' : 'ecomm';
}

function formatYmd(date) {
  if (!date) return null;
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function serializeFile(file) {
  if (!file) return null;
  return {
    url: file.url || null,
    publicId: file.publicId || null,
    originalName: file.originalName || null,
    mimeType: file.mimeType || null,
    sizeBytes: file.sizeBytes == null ? null : file.sizeBytes,
    kind: file.kind || null,
  };
}

function serializeListRow(row) {
  const logos = Array.isArray(row.logos) ? row.logos : [];
  const refs = Array.isArray(row.referencePhotos) ? row.referencePhotos : [];
  return {
    id: row._id,
    enquiryType: row.enquiryType,
    name: row.name,
    email: row.email,
    phone: row.phone,
    organizationName: row.organizationName || null,
    city: row.city || null,
    occasion: row.occasion || null,
    giftCategory: row.giftCategory || null,
    quantity: row.quantity == null ? null : row.quantity,
    targetDeliveryDate: formatYmd(row.targetDeliveryDate),
    businessType: row.businessType || null,
    volumeOrder: row.volumeOrder == null ? null : row.volumeOrder,
    hasBusinessCard: Boolean(row.businessCard && row.businessCard.url),
    status: row.status,
    storefront: row.storefront,
    referencePhotoCount: refs.length,
    logoCount: logos.length,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function serializeDetail(row) {
  return {
    ...serializeListRow(row),
    message: row.message || null,
    logos: (row.logos || []).map(serializeFile),
    referencePhotos: (row.referencePhotos || []).map(serializeFile),
    businessCard: serializeFile(row.businessCard),
    adminNote: row.adminNote || null,
    convertedOrderId: row.convertedOrderId || null,
    contactedAt: row.contactedAt || null,
    quotedAt: row.quotedAt || null,
    closedAt: row.closedAt || null,
    convertedAt: row.convertedAt || null,
  };
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * POST /api/gift-enquiries
 */
exports.submitCorporateGiftEnquiry = async (req, res) => {
  let uploadedAssets = [];
  try {
    const payload = validateGiftEnquiryPayload(req.body || {});
    const files = pickEnquiryFiles(req);
    validateEnquiryFiles(payload.enquiryType, files);

    const since = new Date(Date.now() - DUPLICATE_WINDOW_MS);
    const existing = await CorporateGiftEnquiry.findOne({
      phone: payload.phone,
      enquiryType: payload.enquiryType,
      status: { $in: OPEN_STATUSES },
      createdAt: { $gte: since },
    })
      .select('_id status createdAt enquiryType')
      .lean();

    if (existing) {
      return res.status(200).json({
        success: true,
        alreadyRegistered: true,
        message: 'We already have your enquiry. Our team will contact you shortly.',
        data: {
          id: existing._id,
          enquiryType: existing.enquiryType,
          status: existing.status,
          createdAt: existing.createdAt,
        },
      });
    }

    const assets = await uploadEnquiryAssets(payload, files);
    uploadedAssets = [
      ...(assets.logos || []),
      ...(assets.referencePhotos || []),
      ...(assets.businessCard ? [assets.businessCard] : []),
    ];

    const userId =
      req.userId && mongoose.Types.ObjectId.isValid(String(req.userId)) ? req.userId : null;

    const doc = await CorporateGiftEnquiry.create({
      ...payload,
      logos: assets.logos,
      referencePhotos: assets.referencePhotos,
      businessCard: assets.businessCard || null,
      storefront: resolveStorefront(req),
      source: 'gift_page',
      userId,
      status: 'pending',
    });

    enqueueGiftEnquiryEmails(doc);

    return res.status(201).json({
      success: true,
      alreadyRegistered: false,
      message: 'Thanks! We received your enquiry and will contact you shortly.',
      data: {
        id: doc._id,
        enquiryType: doc.enquiryType,
        status: doc.status,
        createdAt: doc.createdAt,
      },
    });
  } catch (err) {
    if (uploadedAssets.length) {
      await rollbackUploads(uploadedAssets);
    }
    return sendError(res, err, 'Could not submit gifting enquiry');
  }
};

/**
 * GET /api/admin/gift-enquiries
 */
exports.listCorporateGiftEnquiries = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '20'), 10) || 20));
    const skip = (page - 1) * limit;

    const storefront = resolveStorefront(req);
    const filter = { storefront };

    const statusRaw = String(req.query.status || '').trim().toLowerCase();
    if (statusRaw && statusRaw !== 'all') {
      if (!STATUS_ENUM.includes(statusRaw)) {
        throw createHttpError(400, 'INVALID_STATUS', 'Invalid status filter', 'status');
      }
      filter.status = statusRaw;
    }

    const typeRaw = String(req.query.enquiryType || '').trim().toLowerCase();
    if (typeRaw && typeRaw !== 'all') {
      if (!ENQUIRY_TYPES.includes(typeRaw)) {
        throw createHttpError(400, 'VALIDATION_FAILED', 'enquiryType must be custom or bulk', 'enquiryType');
      }
      filter.enquiryType = typeRaw;
    }

    const search = String(req.query.search || '').trim();
    if (search) {
      const re = new RegExp(escapeRegex(search), 'i');
      const digits = search.replace(/\D/g, '');
      filter.$or = [
        { name: re },
        { email: re },
        { phone: re },
        { organizationName: re },
        { city: re },
        { occasion: re },
        { giftCategory: re },
        { businessType: re },
      ];
      if (digits.length >= 4) {
        filter.$or.push({ phone: new RegExp(escapeRegex(digits), 'i') });
      }
    }

    const [rows, total] = await Promise.all([
      CorporateGiftEnquiry.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select(
          'enquiryType name email phone organizationName city occasion giftCategory quantity targetDeliveryDate businessType volumeOrder businessCard status storefront logos referencePhotos createdAt updatedAt'
        )
        .lean(),
      CorporateGiftEnquiry.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: rows.map(serializeListRow),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 0,
        hasNextPage: page * limit < total,
        hasPrevPage: page > 1,
      },
    });
  } catch (err) {
    return sendError(res, err, 'Could not load gifting enquiries');
  }
};

/**
 * GET /api/admin/gift-enquiries/:id
 */
exports.getCorporateGiftEnquiry = async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw createHttpError(400, 'INVALID_ID', 'Valid enquiry id is required');
    }

    const doc = await CorporateGiftEnquiry.findOne({
      _id: id,
      storefront: resolveStorefront(req),
    }).lean();

    if (!doc) {
      throw createHttpError(404, 'NOT_FOUND', 'Enquiry not found');
    }

    return res.json({
      success: true,
      data: serializeDetail(doc),
    });
  } catch (err) {
    return sendError(res, err, 'Could not load gifting enquiry');
  }
};

/**
 * PATCH /api/admin/gift-enquiries/:id/status
 */
exports.updateCorporateGiftEnquiryStatus = async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw createHttpError(400, 'INVALID_ID', 'Valid enquiry id is required');
    }

    const nextStatus = parseAdminStatus(req.body?.status);
    const adminNote = parseAdminNote(req.body?.adminNote);
    const convertedOrderIdRaw =
      req.body?.convertedOrderId == null
        ? undefined
        : String(req.body.convertedOrderId).trim().slice(0, 80) || null;

    const doc = await CorporateGiftEnquiry.findOne({
      _id: id,
      storefront: resolveStorefront(req),
    });
    if (!doc) {
      throw createHttpError(404, 'NOT_FOUND', 'Enquiry not found');
    }

    doc.status = nextStatus;
    if (adminNote !== undefined) doc.adminNote = adminNote;
    if (convertedOrderIdRaw !== undefined) doc.convertedOrderId = convertedOrderIdRaw;

    if (nextStatus === 'contacted') doc.contactedAt = doc.contactedAt || new Date();
    if (nextStatus === 'quoted') doc.quotedAt = doc.quotedAt || new Date();
    if (nextStatus === 'closed') doc.closedAt = new Date();
    if (nextStatus === 'converted') doc.convertedAt = doc.convertedAt || new Date();
    if (nextStatus === 'pending') {
      doc.contactedAt = null;
      doc.quotedAt = null;
      doc.closedAt = null;
      doc.convertedAt = null;
    }

    await doc.save();

    return res.json({
      success: true,
      message: 'Enquiry status updated',
      data: serializeDetail(doc.toObject()),
    });
  } catch (err) {
    return sendError(res, err, 'Could not update enquiry status');
  }
};
