const crypto = require('crypto');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { validationResult } = require('express-validator');
const path = require('path');
const WholesalerDetails = require('../models/WholesalerDetails');
const User = require('../models/User');
const { generateOTP, sendOTP, deliverOtpFor, getOtpExpiryMs } = require('../services/otp.service');
const { buildWholesalerPdfPreviewUrl } = require('../utils/cloudinaryProofDelivery');
const { uploadBufferToR2 } = require('../utils/r2Storage');
const { optimizeProductImageBuffer } = require('../utils/cloudinaryHelper');
const { deleteFromR2ByUrl } = require('../utils/r2Storage');
const { getRefreshCookieOptions } = require('../utils/refreshCookieOptions');

// Wholesaler activation OTP follows the same global expiry window as every
// other OTP flow. Driven by OTP_EXPIRY_MINUTES env (default: 5 minutes).
const OTP_TTL_MS = getOtpExpiryMs();
const MAX_OTP_ATTEMPTS = 5;
const ACCESS_EXPIRES = process.env.ACCESS_TOKEN_EXPIRES || '15m';
const REFRESH_EXPIRES = process.env.REFRESH_TOKEN_EXPIRES || '7d';

const OWNER_REVIEW_PURPOSE = 'wholesaler_owner_review';
const OWNER_REVIEW_TOKEN_EXPIRES = process.env.OWNER_REVIEW_TOKEN_EXPIRES || '48h';
const PRIVILEGED_OPERATIONAL_ROLES = new Set(['admin', 'product_manager', 'order_manager', 'marketing_manager']);

function normalizePhone(v) {
  return String(v || '').replace(/\D/g, '').slice(-10);
}

/** E.164-style digits for wa.me (India 91 + 10 digits). */
function rawDigitsToWaMePath(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits;
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(-10)}`;
  return null;
}

/**
 * Frontend URL where approved wholesalers complete activation (OTP + password).
 * Override per environment; server must be restarted after .env changes.
 * In production this MUST be set — otherwise the email/SMS link would point to localhost.
 */
function getWholesalerActivateAppUrl() {
  const raw = String(process.env.WHOLESALER_ACTIVATE_APP_URL || '').trim().replace(/\/$/, '');
  if (raw) return raw;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('WHOLESALER_ACTIVATE_APP_URL must be set in production');
  }
  return 'http://localhost:5173/activate';
}

function hashString(v) {
  return crypto.createHash('sha256').update(String(v)).digest('hex');
}

function getOwnerReviewSecret() {
  return String(process.env.OWNER_REVIEW_JWT_SECRET || process.env.JWT_SECRET || '').trim();
}

function signOwnerReviewToken(requestId, linkVersion) {
  const secret = getOwnerReviewSecret();
  if (!secret) {
    throw new Error('OWNER_REVIEW_JWT_SECRET or JWT_SECRET must be set');
  }
  return jwt.sign(
    {
      sub: String(requestId),
      purpose: OWNER_REVIEW_PURPOSE,
      v: Number(linkVersion)
    },
    secret,
    { expiresIn: OWNER_REVIEW_TOKEN_EXPIRES }
  );
}

function verifyOwnerReviewToken(token) {
  const secret = getOwnerReviewSecret();
  if (!secret) {
    throw new Error('OWNER_REVIEW_JWT_SECRET or JWT_SECRET must be set');
  }
  const decoded = jwt.verify(token, secret);
  if (decoded.purpose !== OWNER_REVIEW_PURPOSE || !decoded.sub) {
    throw new jwt.JsonWebTokenError('Invalid owner review token');
  }
  if (!Number.isFinite(Number(decoded.v))) {
    throw new jwt.JsonWebTokenError('Invalid token version');
  }
  return { requestId: decoded.sub, version: Number(decoded.v) };
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return map[c] || c;
  });
}

/** Safe http(s) URL for HTML attributes (href / img src for remote assets). */
function safeHttpUrlForAttr(raw) {
  const u = String(raw || '').trim();
  try {
    const parsed = new URL(u);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return parsed.href;
  } catch (_) {
    /* ignore */
  }
  return '';
}

/**
 * Classify ID / business proof field for UI (admin + owner review page).
 * Legacy rows may store non-URL blobs; those are surfaced as opaque, not as broken links.
 * @param {object} [_options] reserved for future use
 */
function classifyWholesalerProof(raw, _options = {}) {
  const value = String(raw ?? '').trim();
  if (!value) {
    return {
      kind: 'empty',
      href: null,
      openHref: null,
      originalHref: null,
      pdfPreviewHref: null,
      viewerIsRasterized: false,
      label: 'Not provided',
      isImage: false,
      isPdf: false
    };
  }
  const httpHref = safeHttpUrlForAttr(value);
  if (httpHref) {
    const lower = httpHref.toLowerCase();
    const isPdf =
      lower.endsWith('.pdf') ||
      /\/image\/upload\/[^?]*\.pdf(\?|$)/i.test(lower) ||
      /\/raw\/upload\//.test(lower) ||
      /format=pdf/.test(lower) ||
      lower.includes('content-type=application%2Fpdf');
    const isImage =
      !isPdf &&
      (/\.(jpe?g|png|gif|webp|avif)(\?|$)/i.test(lower) ||
        /\/image\/upload\//.test(lower) ||
        /res\.cloudinary\.com/.test(lower));
    // PDF public URLs often return 401 when Cloudinary "PDF and ZIP delivery" is off (typical on free tiers).
    // Page-1 as JPEG uses image delivery and still works; see utils/cloudinaryProofDelivery.js.
    const pdfPreviewHref = isPdf ? buildWholesalerPdfPreviewUrl(httpHref) : null;
    const openHref = pdfPreviewHref || httpHref;
    return {
      kind: 'url',
      href: httpHref,
      originalHref: httpHref,
      pdfPreviewHref,
      openHref,
      viewerIsRasterized: Boolean(pdfPreviewHref),
      label: isPdf ? 'PDF document' : isImage ? 'Image' : 'File link',
      isImage,
      isPdf
    };
  }
  if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,/i.test(value)) {
    return {
      kind: 'dataUrl',
      href: value,
      openHref: value,
      originalHref: value,
      pdfPreviewHref: null,
      viewerIsRasterized: false,
      label: 'Embedded image (legacy)',
      isImage: true,
      isPdf: false
    };
  }
  if (/^data:application\/pdf/i.test(value)) {
    return {
      kind: 'dataUrl',
      href: value,
      openHref: value,
      originalHref: value,
      pdfPreviewHref: null,
      viewerIsRasterized: false,
      label: 'Embedded PDF (legacy)',
      isImage: false,
      isPdf: true
    };
  }
  const preview = value.length > 160 ? `${value.slice(0, 160)}…` : value;
  return {
    kind: 'opaque',
    href: null,
    openHref: null,
    originalHref: null,
    pdfPreviewHref: null,
    viewerIsRasterized: false,
    label: 'Stored value is not a public URL (legacy upload or truncated data).',
    isImage: false,
    isPdf: false,
    preview
  };
}

async function cleanupWholesalerProofIfPresent(rawUrl) {
  const safeUrl = String(rawUrl || '').trim();
  if (!safeUrl) return;
  try {
    await deleteFromR2ByUrl(safeUrl);
  } catch (error) {
    // Legacy/non-R2 URLs may exist; cleanup failure must not crash request flow.
    console.error('Wholesaler proof cleanup failed:', error.message);
  }
}

function buildOwnerReviewTableRows(doc) {
  const rows = [
    ['Full name', doc.fullName],
    ['WhatsApp', doc.whatsappNumber],
    ['Mobile', doc.mobileNumber],
    ['Email', doc.email],
    ['Permanent address', doc.permanentAddress],
    ['Have shop', doc.haveShop ? 'Yes' : 'No'],
    ['Business address', doc.businessAddress],
    ['Delivery address', doc.deliveryAddress],
    ['Selling from', doc.sellingPlaceFrom],
    ['City / zone', doc.sellingZoneCity],
    ['Product category', doc.productCategory],
    ['Est. monthly purchase (₹)', String(doc.monthlyEstimatedPurchase)]
  ];
  return rows
    .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(String(v ?? ''))}</td></tr>`)
    .join('');
}

function buildOwnerReviewDocArticle(title, info) {
  const h = escapeHtml(title);
  if (info.kind === 'empty') {
    return `<article class="doc doc-missing"><h3>${h}</h3><p class="muted">No file on record.</p></article>`;
  }
  if (info.kind === 'opaque') {
    return `<article class="doc doc-warn"><h3>${h}</h3><p>${escapeHtml(info.label)}</p>${
      info.preview ? `<pre class="preview">${escapeHtml(info.preview)}</pre>` : ''
    }</article>`;
  }
  const open = escapeHtml(info.openHref || info.href || '');
  if (info.kind === 'url' && info.isImage && !info.isPdf) {
    return `<article class="doc"><h3>${h}</h3><p class="meta">${escapeHtml(info.label)}</p>
      <div class="row-btns"><a class="btn secondary" href="${open}" target="_blank" rel="noopener noreferrer">Open in new tab</a></div>
      <details class="preview"><summary>Show image preview</summary>
      <div class="preview-frame"><img src="${open}" alt="${h}" loading="lazy" decoding="async" /></div>
      </details></article>`;
  }
  if (info.kind === 'url' && info.isPdf) {
    const orig = escapeHtml(info.originalHref || info.href || '');
    if (info.viewerIsRasterized && info.pdfPreviewHref) {
      const prev = escapeHtml(info.pdfPreviewHref);
      return `<article class="doc"><h3>${h}</h3><p class="meta">${escapeHtml(info.label)}</p>
      <div class="row-btns">
        <a class="btn" href="${prev}" target="_blank" rel="noopener noreferrer">View proof (page 1)</a>
        <a class="btn secondary" href="${orig}" target="_blank" rel="noopener noreferrer">Open original PDF</a>
      </div>
      <p class="hint">View proof (page 1) is a JPEG and works even when Cloudinary blocks public PDF delivery. For the full PDF, enable <strong>Allow delivery of PDF and ZIP files</strong> in Cloudinary Settings → Security, or use the second link if your plan already allows it.</p></article>`;
    }
    return `<article class="doc"><h3>${h}</h3><p class="meta">${escapeHtml(info.label)}</p>
      <div class="row-btns"><a class="btn" href="${orig}" target="_blank" rel="noopener noreferrer">Open PDF</a></div>
      <p class="hint">Preview unavailable for this URL (e.g. legacy <code>raw</code> upload). Enable PDF delivery in Cloudinary Security settings or ask the applicant to re-upload proofs.</p></article>`;
  }
  if (info.kind === 'url') {
    return `<article class="doc"><h3>${h}</h3><p class="meta">${escapeHtml(info.label)}</p>
      <a class="btn" href="${open}" target="_blank" rel="noopener noreferrer">Open file</a></article>`;
  }
  if (info.kind === 'dataUrl' && info.isImage) {
    const esc = escapeHtml(info.href);
    return `<article class="doc"><h3>${h}</h3><p class="meta">${escapeHtml(info.label)}</p>
      <details class="preview"><summary>Show image preview</summary>
      <div class="preview-frame"><img src="${esc}" alt="${h}" /></div></details></article>`;
  }
  if (info.kind === 'dataUrl') {
    const esc = escapeHtml(info.href);
    return `<article class="doc"><h3>${h}</h3><p class="meta">${escapeHtml(info.label)}</p>
      <a class="btn" href="${esc}" download="wholesaler-proof.pdf">Download</a></article>`;
  }
  return `<article class="doc doc-warn"><h3>${h}</h3><p>Unknown attachment type.</p></article>`;
}

function buildOwnerReviewDocsSection(idMedia, bizMedia) {
  return `<div class="doc-grid">${buildOwnerReviewDocArticle('ID proof', idMedia)}${buildOwnerReviewDocArticle(
    'Business address proof',
    bizMedia
  )}</div>`;
}

function buildOwnerReviewPageHtml({ doc, token, apiBase }) {
  const templatePath = path.join(__dirname, '..', 'templates', 'wholesaler-owner-review.html');
  const template = fs.readFileSync(templatePath, 'utf8');
  const idMedia = classifyWholesalerProof(doc.idProofUpload, { attachmentFilename: 'wholesaler-id-proof.pdf' });
  const bizMedia = classifyWholesalerProof(doc.businessAddressProofUpload, {
    attachmentFilename: 'wholesaler-business-proof.pdf'
  });
  const summaryLine = escapeHtml(`${doc.fullName} · ${doc.sellingZoneCity} · ${doc.productCategory}`);
  const decisionUrl = escapeHtml(`${apiBase}/api/wholesaler/owner-review/decision`);
  const tokenField = escapeHtml(token);
  return template
    .replace(/\{\{SUMMARY_LINE\}\}/g, summaryLine)
    .replace(/\{\{TABLE_ROWS\}\}/g, buildOwnerReviewTableRows(doc))
    .replace(/\{\{DOCS_SECTION\}\}/g, buildOwnerReviewDocsSection(idMedia, bizMedia))
    .replace(/\{\{DECISION_URL\}\}/g, decisionUrl)
    .replace(/\{\{TOKEN\}\}/g, tokenField);
}

function buildPublicApiBase(req) {
  const envBase = String(process.env.PUBLIC_API_BASE_URL || process.env.API_PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  if (envBase) return envBase;
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.get('host') || '').split(',')[0].trim();
  if (!host) return '';
  return `${proto}://${host}`;
}

const REFRESH_COOKIE_BY_PORTAL = {
  ecomm: 'refreshToken_ecomm',
  wholesale: 'refreshToken_wholesale',
  'admin-ecomm': 'refreshToken_admin_ecomm',
  'admin-wholesale': 'refreshToken_admin_wholesale'
};

function resolveRefreshCookieName(portal) {
  return REFRESH_COOKIE_BY_PORTAL[portal] || REFRESH_COOKIE_BY_PORTAL.ecomm;
}

function setRefreshTokenCookie(req, res, portal, refreshToken) {
  const cookieName = resolveRefreshCookieName(portal);
  const cookieOptions = getRefreshCookieOptions(req);
  res.cookie(cookieName, refreshToken, cookieOptions);
  if (cookieName !== 'refreshToken') {
    // Cleanup legacy shared cookie to avoid cross-portal session bleed.
    res.clearCookie('refreshToken', cookieOptions);
  }
}

function authContractError(res, status, code, message, extras = {}) {
  return res.status(status).json({
    success: false,
    code,
    message,
    ...extras
  });
}

function sanitizePublicIdPart(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'proof';
}

async function uploadProofBufferToCloudinary(file, folder, publicIdPrefix) {
  if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
    throw new Error('Proof upload failed: empty or invalid file buffer');
  }
  if (file.buffer.length > 5 * 1024 * 1024) {
    throw new Error('Proof upload failed: file exceeds max size limit of 5MB');
  }

  const ext = path.extname(String(file.originalname || '')).toLowerCase();
  const isPdf = file.mimetype === 'application/pdf' || ext === '.pdf';
  const publicId = `${publicIdPrefix}-${Date.now()}`;

  if (isPdf) {
    const upload = await uploadBufferToR2({
      buffer: file.buffer,
      folderPath: folder,
      publicIdName: publicId,
      contentType: 'application/pdf',
      extension: 'pdf',
      cacheControl: 'public, max-age=31536000, immutable'
    });
    return {
      url: upload.url,
      publicId: `r2:${upload.key}`,
      resourceType: 'raw'
    };
  }

  const optimizedBuffer = await optimizeProductImageBuffer(file.buffer);
  const upload = await uploadBufferToR2({
    buffer: optimizedBuffer,
    folderPath: folder,
    publicIdName: publicId,
    contentType: 'image/webp',
    extension: 'webp',
    cacheControl: 'public, max-age=31536000, immutable'
  });
  return {
    url: upload.url,
    publicId: `r2:${upload.key}`,
    resourceType: 'image'
  };
}

async function resolveWholesalerProofUrls(req, payload) {
  const files = req.files || {};
  const pickFirst = (...keys) => {
    for (const key of keys) {
      if (Array.isArray(files[key]) && files[key][0]) return files[key][0];
    }
    return null;
  };
  const idProofFile = pickFirst('idProof', 'idProofUpload', 'idProofFile');
  const businessProofFile = pickFirst(
    'businessAddressProof',
    'businessAddressProofUpload',
    'businessAddressProofFile'
  );

  const uploads = [];

  if (idProofFile) {
    uploads.push(
      uploadProofBufferToCloudinary(
        idProofFile,
        'wholesaler/proofs/id',
        sanitizePublicIdPart(`${payload.fullName}-id-proof`)
      ).then((r) => {
        payload.idProofUpload = r.url;
      })
    );
  }

  if (businessProofFile) {
    uploads.push(
      uploadProofBufferToCloudinary(
        businessProofFile,
        'wholesaler/proofs/business',
        sanitizePublicIdPart(`${payload.fullName}-business-proof`)
      ).then((r) => {
        payload.businessAddressProofUpload = r.url;
      })
    );
  }

  if (uploads.length) {
    await Promise.all(uploads);
  }
}

function generateAccessToken(userId, userType = 'user', role = 'user', portal = 'wholesale') {
  return jwt.sign(
    { id: userId, type: 'access', userType, role, portal },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_EXPIRES }
  );
}

function isPrivilegedOperationalRole(role) {
  return PRIVILEGED_OPERATIONAL_ROLES.has(String(role || '').trim().toLowerCase());
}

function isPrivilegedAccount(user) {
  if (!user) return false;
  const normalizedUserType = String(user.userType || '').trim().toLowerCase();
  if (normalizedUserType === 'admin') return true;
  return isPrivilegedOperationalRole(user.role);
}

function isWholesalerAccount(user) {
  if (!user) return false;
  const normalizedUserType = String(user.userType || '').trim().toLowerCase();
  const normalizedRole = String(user.role || '').trim().toLowerCase();
  return normalizedUserType === 'wholesaler' || normalizedRole === 'wholesaler';
}

function buildPrivilegedConflictPayload() {
  return {
    success: false,
    code: 'IDENTITY_RESERVED_FOR_PRIVILEGED',
    message: 'This mobile/email belongs to a privileged admin/staff account and cannot be used for wholesaler onboarding.'
  };
}

function buildExistingWholesalerConflictPayload(status, requestId = null) {
  const normalizedStatus = String(status || '').trim().toLowerCase();
  if (normalizedStatus === 'activated') {
    return {
      success: false,
      code: 'WHOLESALER_ALREADY_ACTIVE',
      message: 'A wholesaler account already exists for this mobile/email.',
      requestId
    };
  }
  if (normalizedStatus === 'approved') {
    return {
      success: false,
      code: 'WHOLESALER_ALREADY_APPROVED',
      message: 'A wholesaler request for this mobile/email is already approved. Please activate the account instead of submitting a new request.',
      requestId
    };
  }
  return {
    success: false,
    code: 'WHOLESALER_REQUEST_ALREADY_EXISTS',
    message: 'A wholesaler request already exists for this mobile/email.',
    requestId
  };
}

function generateRefreshToken(userId) {
  return jwt.sign(
    { id: userId, type: 'refresh' },
    process.env.REFRESH_TOKEN_SECRET,
    { expiresIn: REFRESH_EXPIRES }
  );
}

exports.submitWholesalerRequest = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
    }

    const payload = {
      fullName: req.body.fullName,
      whatsappNumber: normalizePhone(req.body.whatsappNumber),
      mobileNumber: normalizePhone(req.body.mobileNumber),
      email: String(req.body.email || '').trim().toLowerCase(),
      permanentAddress: req.body.permanentAddress,
      haveShop: req.body.haveShop === true || req.body.haveShop === 'true',
      businessAddress: req.body.businessAddress,
      deliveryAddress: req.body.deliveryAddress,
      sellingPlaceFrom: req.body.sellingPlaceFrom,
      sellingZoneCity: req.body.sellingZoneCity,
      productCategory: req.body.productCategory,
      monthlyEstimatedPurchase: Number(req.body.monthlyEstimatedPurchase),
      idProofUpload: req.body.idProofUpload,
      businessAddressProofUpload: req.body.businessAddressProofUpload
    };

    await resolveWholesalerProofUrls(req, payload);

    if (!/^\d{10}$/.test(payload.mobileNumber)) {
      return res.status(400).json({ success: false, message: 'Valid 10-digit mobileNumber is required' });
    }
    if (!/^\d{10}$/.test(payload.whatsappNumber)) {
      return res.status(400).json({ success: false, message: 'Valid 10-digit whatsappNumber is required' });
    }
    if (!payload.email || !payload.fullName || !payload.permanentAddress) {
      return res.status(400).json({ success: false, message: 'Missing required wholesaler details' });
    }
    if (!payload.idProofUpload || !payload.businessAddressProofUpload) {
      return res.status(400).json({
        success: false,
        message:
          'idProofUpload and businessAddressProofUpload are required (provide URLs or upload files as idProof/businessAddressProof)'
      });
    }

    const existingUser = await User.findOne({
      $or: [{ phone: payload.mobileNumber }, { email: payload.email }]
    }).select('userType role status');

    if (isPrivilegedAccount(existingUser)) {
      return res.status(409).json(buildPrivilegedConflictPayload());
    }

    if (isWholesalerAccount(existingUser)) {
      return res.status(409).json(buildExistingWholesalerConflictPayload('activated'));
    }

    const existingRequest = await WholesalerDetails.findOne({
      status: { $in: ['pending', 'approved', 'activated'] },
      $or: [{ mobileNumber: payload.mobileNumber }, { email: payload.email }]
    })
      .sort({ updatedAt: -1 })
      .select('_id status');

    if (existingRequest) {
      return res.status(409).json(buildExistingWholesalerConflictPayload(existingRequest.status, existingRequest._id));
    }

    const requestDoc = await WholesalerDetails.create({
      ...payload,
      userId: null,
      isApproved: false,
      status: 'pending',
      ownerReviewLinkVersion: 0
    });

    return res.status(201).json({
      success: true,
      message: 'Wholesaler request submitted successfully. Admin will notify the owner for review.',
      request: {
        id: requestDoc._id,
        status: requestDoc.status,
        fullName: requestDoc.fullName,
        mobileNumber: requestDoc.mobileNumber
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Error submitting wholesaler request', error: error.message });
  }
};

exports.listWholesalerRequests = async (req, res) => {
  try {
    const allowedStatuses = ['pending', 'approved', 'rejected', 'activated'];
    const status = String(req.query.status || 'all').toLowerCase();
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const skip = (page - 1) * limit;

    const query =
      status === 'all'
        ? {}
        : allowedStatuses.includes(status)
          ? { status }
          : {};

    const total = await WholesalerDetails.countDocuments(query);
    // Full application row for admin (all stored fields). OTP hash stays off via schema select:false.
    const rows = await WholesalerDetails.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('reviewedBy ownerNotifiedBy linkedUserId userId', 'name email phone userType role')
      .lean();

    const requests = rows.map((row) => ({
      ...row,
      ownerReviewMirror: {
        ...requestSummaryForOwner(row),
        media: {
          idProof: classifyWholesalerProof(row.idProofUpload),
          businessAddressProof: classifyWholesalerProof(row.businessAddressProofUpload)
        }
      }
    }));

    return res.status(200).json({
      success: true,
      filters: {
        status: status === 'all' || allowedStatuses.includes(status) ? status : 'all'
      },
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(Math.ceil(total / limit), 1)
      },
      requests
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Error fetching wholesaler requests', error: error.message });
  }
};

exports.getWholesalerRequestSummary = async (req, res) => {
  try {
    const counts = await WholesalerDetails.aggregate([
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 }
        }
      }
    ]);

    const summary = {
      all: 0,
      pending: 0,
      approved: 0,
      rejected: 0,
      activated: 0
    };

    for (const row of counts) {
      const key = String(row._id || '').toLowerCase();
      if (Object.prototype.hasOwnProperty.call(summary, key)) {
        summary[key] = Number(row.count || 0);
        summary.all += Number(row.count || 0);
      }
    }

    return res.status(200).json({ success: true, summary });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Error fetching request summary', error: error.message });
  }
};

exports.getWholesalerRequestDetails = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
    }
    const doc = await WholesalerDetails.findById(req.params.id).populate('reviewedBy ownerNotifiedBy linkedUserId', 'name email phone userType role');
    if (!doc) {
      return res.status(404).json({ success: false, message: 'Wholesaler request not found' });
    }
    const plain = doc.toObject ? doc.toObject() : doc;
    const ownerReviewMirror = {
      ...requestSummaryForOwner(plain),
      media: {
        idProof: classifyWholesalerProof(plain.idProofUpload),
        businessAddressProof: classifyWholesalerProof(plain.businessAddressProofUpload)
      }
    };
    return res.status(200).json({
      success: true,
      request: plain,
      /** Same applicant + document context as the owner review link (for admin UIs). */
      ownerReviewMirror,
      recordHint: 'MongoDB model WholesalerDetails; this document is the wholesaler application row.'
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Error fetching request details', error: error.message });
  }
};

/**
 * Admin: bump review link version, record notify audit, return wa.me payload for owner.
 * Each call invalidates any previously issued owner review link for this request.
 */
exports.buildNotifyOwnerPayload = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
    }

    // Owner destination for wa.me — only env (restart server after changing .env).
    const ownerPhoneRaw = String(process.env.OWNER_WHATSAPP_NUMBER || '').trim();
    const ownerWaPath = rawDigitsToWaMePath(ownerPhoneRaw);
    if (!ownerWaPath) {
      return res.status(503).json({
        success: false,
        message: 'OWNER_WHATSAPP_NUMBER is not configured (10-digit or 91XXXXXXXXXX)'
      });
    }

    let doc;
    try {
      doc = await WholesalerDetails.findOneAndUpdate(
        { _id: req.params.id, status: 'pending' },
        {
          $inc: { ownerReviewLinkVersion: 1 },
          $set: {
            ownerNotifiedAt: new Date(),
            ownerNotifiedBy: req.userId ? new mongoose.Types.ObjectId(req.userId) : null
          }
        },
        { new: true }
      );
    } catch (e) {
      return res.status(400).json({ success: false, message: 'Invalid request id' });
    }

    if (!doc) {
      return res.status(409).json({
        success: false,
        message: 'Request not found or not in pending status'
      });
    }

    let token;
    try {
      token = signOwnerReviewToken(doc._id, doc.ownerReviewLinkVersion);
    } catch (e) {
      return res.status(500).json({ success: false, message: e.message || 'Cannot sign review token' });
    }

    const apiBase = buildPublicApiBase(req);
    if (!apiBase) {
      return res.status(503).json({
        success: false,
        message: 'Set PUBLIC_API_BASE_URL (or API_PUBLIC_BASE_URL) so the owner review link can be generated'
      });
    }

    const reviewUrl = `${apiBase}/api/wholesaler/owner-review?t=${encodeURIComponent(token)}`;
    const messagePlain = [
      '*Wholesaler request — action required*',
      `Name: ${doc.fullName}`,
      `Mobile: ${doc.mobileNumber}`,
      `City: ${doc.sellingZoneCity}`,
      `Category: ${doc.productCategory}`,
      '',
      'Open this secure link to approve or reject:',
      reviewUrl
    ].join('\n');

    const waMeUrl = `https://wa.me/${ownerWaPath}?text=${encodeURIComponent(messagePlain)}`;

    return res.status(200).json({
      success: true,
      waMeUrl,
      messagePlain,
      reviewUrl,
      ownerWaPath,
      request: {
        id: doc._id,
        status: doc.status,
        ownerReviewLinkVersion: doc.ownerReviewLinkVersion,
        ownerNotifiedAt: doc.ownerNotifiedAt
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Error building owner notify payload', error: error.message });
  }
};

/**
 * Admin: prefilled WhatsApp for the applicant after owner decision (approved / rejected).
 */
exports.buildNotifyApplicantPayload = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
    }

    const doc = await WholesalerDetails.findById(req.params.id).select(
      'fullName whatsappNumber mobileNumber status email'
    );
    if (!doc) {
      return res.status(404).json({ success: false, message: 'Wholesaler request not found' });
    }

    const applicantPath = rawDigitsToWaMePath(doc.whatsappNumber);
    if (!applicantPath) {
      return res.status(400).json({ success: false, message: 'Applicant WhatsApp number is invalid' });
    }

    if (doc.status === 'pending') {
      return res.status(409).json({
        success: false,
        message: 'Request is still pending owner review. Notify the applicant after a decision.'
      });
    }

    if (doc.status === 'activated') {
      return res.status(409).json({
        success: false,
        message: 'Applicant has already completed activation'
      });
    }

    let messagePlain;
    if (doc.status === 'approved') {
      const activateUrl = getWholesalerActivateAppUrl();
      messagePlain = [
        `Hello ${doc.fullName},`,
        '',
        '*Good news:* your wholesaler application has been approved.',
        '',
        'Click to activate your account (open in browser):',
        activateUrl,
        '',
        'Complete account setup: request OTP on the app/website using your registered mobile number, then set your password.',
        `Registered mobile: ${doc.mobileNumber}`,
        '',
        '— Team OfferWaleBaba'
      ].join('\n');
    } else if (doc.status === 'rejected') {
      messagePlain = [
        `Hello ${doc.fullName},`,
        '',
        'Thank you for your interest. Unfortunately your wholesaler application was not approved at this time.',
        '',
        '— Team OfferWaleBaba'
      ].join('\n');
    } else {
      return res.status(409).json({ success: false, message: `Unexpected status: ${doc.status}` });
    }

    const waMeUrl = `https://wa.me/${applicantPath}?text=${encodeURIComponent(messagePlain)}`;

    return res.status(200).json({
      success: true,
      waMeUrl,
      messagePlain,
      applicantWaPath: applicantPath,
      request: { id: doc._id, status: doc.status }
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Error building applicant notify payload', error: error.message });
  }
};

function requestSummaryForOwner(doc) {
  return {
    id: doc._id,
    fullName: doc.fullName,
    whatsappNumber: doc.whatsappNumber,
    mobileNumber: doc.mobileNumber,
    email: doc.email,
    permanentAddress: doc.permanentAddress,
    haveShop: doc.haveShop,
    businessAddress: doc.businessAddress,
    deliveryAddress: doc.deliveryAddress,
    sellingPlaceFrom: doc.sellingPlaceFrom,
    sellingZoneCity: doc.sellingZoneCity,
    productCategory: doc.productCategory,
    monthlyEstimatedPurchase: doc.monthlyEstimatedPurchase,
    idProofUpload: doc.idProofUpload,
    businessAddressProofUpload: doc.businessAddressProofUpload,
    status: doc.status,
    createdAt: doc.createdAt
  };
}

exports.getOwnerReviewPage = async (req, res) => {
  try {
    const token = String(req.query.t || req.query.token || '').trim();
    if (!token) {
      return res.status(400).send('Missing review token');
    }

    let payload;
    try {
      payload = verifyOwnerReviewToken(token);
    } catch (e) {
      const msg = e.name === 'TokenExpiredError' ? 'This review link has expired.' : 'Invalid or tampered review link.';
      return res.status(401).send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Review link</title></head><body><p>${escapeHtml(msg)}</p></body></html>`);
    }

    if (!mongoose.Types.ObjectId.isValid(payload.requestId)) {
      return res.status(400).send('Invalid request reference');
    }

    const doc = await WholesalerDetails.findById(payload.requestId);
    if (!doc) {
      return res.status(404).send('Request not found');
    }

    if (doc.ownerReviewLinkVersion !== payload.version) {
      return res.status(401).send('This review link is no longer valid. Ask admin to send a new link.');
    }

    if (doc.status !== 'pending') {
      const label = doc.status === 'approved' ? 'approved' : doc.status === 'rejected' ? 'rejected' : doc.status;
      return res
        .status(200)
        .send(
          `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Already decided</title></head><body><p>This request was already <strong>${escapeHtml(label)}</strong>.</p></body></html>`
        );
    }

    const acceptJson = req.headers.accept && req.headers.accept.includes('application/json');
    const apiBase = buildPublicApiBase(req);
    if (!apiBase) {
      const msg = 'Set PUBLIC_API_BASE_URL (or API_PUBLIC_BASE_URL) so review actions can be submitted.';
      if (acceptJson) {
        return res.status(503).json({ success: false, message: msg });
      }
      return res.status(503).type('html').send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><p>${escapeHtml(msg)}</p></body></html>`);
    }

    if (acceptJson) {
      const summary = requestSummaryForOwner(doc);
      return res.status(200).json({
        success: true,
        request: {
          ...summary,
          media: {
            idProof: classifyWholesalerProof(doc.idProofUpload),
            businessAddressProof: classifyWholesalerProof(doc.businessAddressProofUpload)
          }
        },
        decisionEndpoint: `${apiBase}/api/wholesaler/owner-review/decision`,
        tokenExpiresIn: OWNER_REVIEW_TOKEN_EXPIRES
      });
    }

    const html = buildOwnerReviewPageHtml({ doc, token, apiBase });
    return res.status(200).type('html').send(html);
  } catch (error) {
    return res.status(500).send('Server error');
  }
};

exports.postOwnerReviewDecision = async (req, res) => {
  try {
    const val = validationResult(req);
    if (!val.isEmpty()) {
      return res.status(400).json({ success: false, message: 'Validation failed', errors: val.array() });
    }

    const token = String(req.body.token || '').trim();
    const decision = String(req.body.decision || '').toLowerCase();
    const reason = String(req.body.reason || '').trim().slice(0, 500);

    if (!token || !['approve', 'reject'].includes(decision)) {
      return res.status(400).json({ success: false, message: 'token and decision (approve|reject) are required' });
    }

    let payload;
    try {
      payload = verifyOwnerReviewToken(token);
    } catch (e) {
      const code = e.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN';
      return res.status(401).json({ success: false, message: 'Invalid or expired review token', code });
    }

    if (!mongoose.Types.ObjectId.isValid(payload.requestId)) {
      return res.status(400).json({ success: false, message: 'Invalid request reference' });
    }

    const now = new Date();
    const nextStatus = decision === 'approve' ? 'approved' : 'rejected';
    const update = {
      status: nextStatus,
      isApproved: decision === 'approve',
      reviewedAt: now,
      reviewedBy: null,
      reviewReason: decision === 'reject' ? reason : ''
    };

    const updated = await WholesalerDetails.findOneAndUpdate(
      {
        _id: payload.requestId,
        status: 'pending',
        ownerReviewLinkVersion: payload.version
      },
      { $set: update },
      { new: true }
    );

    if (!updated) {
      const current = await WholesalerDetails.findById(payload.requestId).select('status ownerReviewLinkVersion');
      if (!current) {
        return res.status(404).json({ success: false, message: 'Request not found' });
      }
      if (current.status !== 'pending') {
        return res.status(409).json({
          success: false,
          message: `This request was already ${current.status}`,
          status: current.status
        });
      }
      if (current.ownerReviewLinkVersion !== payload.version) {
        return res.status(409).json({
          success: false,
          message: 'This link is no longer valid. Ask admin to send a new owner notification.',
          code: 'LINK_VERSION_MISMATCH'
        });
      }
      return res.status(409).json({ success: false, message: 'Could not apply decision. Try again.' });
    }

    if (req.is('application/json')) {
      return res.status(200).json({
        success: true,
        message: decision === 'approve' ? 'Request approved.' : 'Request rejected.',
        request: { id: updated._id, status: updated.status }
      });
    }

    const msg =
      decision === 'approve'
        ? 'Thank you. The wholesaler request has been approved.'
        : 'The wholesaler request has been rejected.';
    const ok = decision === 'approve';
    return res.status(200).type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Decision saved</title>
  <link rel="stylesheet" href="/wholesaler/owner-review.css" />
  <style>
    body { display:flex; align-items:center; justify-content:center; min-height:100vh; }
    .done-card { max-width: 400px; text-align: center; padding: 24px; border: 1px solid var(--border); border-radius: 12px; background: #fff; }
    .done-card h1 { margin: 0 0 8px; font-size: 1.2rem; }
    .done-card p { margin: 0; color: var(--muted); font-size: 0.9rem; }
    .done-icon { font-size: 2rem; line-height: 1; margin-bottom: 10px; }
  </style>
</head>
<body>
  <div class="done-card">
    <div class="done-icon">${ok ? '✓' : '✕'}</div>
    <h1>${ok ? 'Approved' : 'Rejected'}</h1>
    <p>${escapeHtml(msg)}</p>
  </div>
</body>
</html>`);
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Error processing decision', error: error.message });
  }
};

exports.approveWholesalerRequest = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
    }
    const doc = await WholesalerDetails.findById(req.params.id);
    if (!doc) {
      return res.status(404).json({ success: false, message: 'Wholesaler request not found' });
    }
    if (doc.status !== 'pending') {
      return res.status(409).json({ success: false, message: `Request already ${doc.status}` });
    }

    doc.status = 'approved';
    doc.isApproved = true;
    doc.reviewReason = String(req.body.reason || '').trim();
    doc.reviewedBy = req.userId || null;
    doc.reviewedAt = new Date();
    await doc.save();

    return res.status(200).json({
      success: true,
      message: 'Wholesaler request approved (superadmin override). Applicant can request activation OTP.',
      request: { id: doc._id, status: doc.status, reviewedAt: doc.reviewedAt }
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Error approving wholesaler request', error: error.message });
  }
};

exports.rejectWholesalerRequest = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
    }
    const doc = await WholesalerDetails.findById(req.params.id);
    if (!doc) {
      return res.status(404).json({ success: false, message: 'Wholesaler request not found' });
    }
    if (doc.status !== 'pending') {
      return res.status(409).json({ success: false, message: `Request already ${doc.status}` });
    }

    await Promise.all([
      cleanupWholesalerProofIfPresent(doc.idProofUpload),
      cleanupWholesalerProofIfPresent(doc.businessAddressProofUpload)
    ]);

    doc.status = 'rejected';
    doc.isApproved = false;
    doc.reviewReason = String(req.body.reason || '').trim();
    doc.reviewedBy = req.userId || null;
    doc.reviewedAt = new Date();
    doc.idProofUpload = '';
    doc.businessAddressProofUpload = '';
    await doc.save();

    return res.status(200).json({
      success: true,
      message: 'Wholesaler request rejected (superadmin override)',
      request: { id: doc._id, status: doc.status, reviewedAt: doc.reviewedAt }
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Error rejecting wholesaler request', error: error.message });
  }
};

exports.sendWholesalerActivationOtp = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return authContractError(res, 400, 'VALIDATION_FAILED', 'Validation failed', {
        errors: errors.array()
      });
    }

    const mobileNumber = normalizePhone(req.body.mobileNumber);
    if (!/^\d{10}$/.test(mobileNumber)) {
      return authContractError(res, 400, 'INVALID_MOBILE_NUMBER', 'Valid 10-digit mobileNumber is required');
    }

    const doc = await WholesalerDetails.findOne({ mobileNumber, status: 'approved' }).sort({ updatedAt: -1 });
    if (!doc) {
      return authContractError(
        res,
        404,
        'WHOLESALER_APPROVAL_NOT_FOUND',
        'No approved wholesaler request found for this mobile number'
      );
    }

    const otp = generateOTP();
    doc.activationOtpHash = hashString(otp);
    doc.activationOtpExpiresAt = new Date(Date.now() + OTP_TTL_MS);
    doc.activationOtpAttempts = 0;
    doc.activationOtpSentAt = new Date();
    await doc.save();

    // Route through the env-aware delivery layer. Wholesaler records have
    // both `mobileNumber` and `email` populated at approval-time, so SMS,
    // Email and Both modes all work seamlessly.
    try {
      await deliverOtpFor({
        phone: doc.mobileNumber,
        email: doc.email,
        otp,
        purpose: 'wholesaler_activation'
      });
    } catch (deliverErr) {
      console.error('Wholesaler activation OTP delivery failed:', deliverErr?.message, deliverErr?.details || '');
      return authContractError(res, 502, 'WHOLESALER_ACTIVATION_OTP_SEND_FAILED', 'Could not send activation OTP. Please try again.');
    }

    return res.status(200).json({
      success: true,
      message: 'Activation OTP sent successfully',
      mobileNumber: doc.mobileNumber
    });
  } catch (error) {
    return authContractError(res, 500, 'WHOLESALER_ACTIVATION_OTP_SEND_FAILED', 'Error sending activation OTP');
  }
};

exports.verifyWholesalerActivationOtp = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return authContractError(res, 400, 'VALIDATION_FAILED', 'Validation failed', {
        errors: errors.array()
      });
    }

    const mobileNumber = normalizePhone(req.body.mobileNumber);
    const otp = String(req.body.otp || '').trim();
    const password = String(req.body.password || '');

    if (!/^\d{10}$/.test(mobileNumber) || !otp || password.length < 6) {
      return authContractError(
        res,
        400,
        'INVALID_ACTIVATION_PAYLOAD',
        'mobileNumber, otp and password (min 6 chars) are required'
      );
    }

    const doc = await WholesalerDetails.findOne({ mobileNumber, status: 'approved' })
      .sort({ updatedAt: -1 })
      .select('+activationOtpHash');

    if (!doc) {
      return authContractError(
        res,
        404,
        'WHOLESALER_APPROVAL_NOT_FOUND',
        'No approved request found for this mobile number'
      );
    }

    if (!doc.activationOtpHash || !doc.activationOtpExpiresAt || new Date() > doc.activationOtpExpiresAt) {
      return authContractError(res, 400, 'OTP_EXPIRED_OR_MISSING', 'OTP expired or not requested');
    }

    if (doc.activationOtpAttempts >= MAX_OTP_ATTEMPTS) {
      return authContractError(res, 429, 'OTP_MAX_ATTEMPTS_EXCEEDED', 'Too many invalid attempts. Request OTP again.');
    }

    const incomingHash = hashString(otp);
    if (incomingHash !== doc.activationOtpHash) {
      doc.activationOtpAttempts += 1;
      await doc.save();
      return authContractError(res, 400, 'OTP_INVALID', 'Invalid OTP');
    }

    let user = await User.findOne({
      $or: [{ phone: doc.mobileNumber }, { email: doc.email }]
    }).select('+password +refreshTokens');

    if (isPrivilegedAccount(user)) {
      return res.status(409).json(buildPrivilegedConflictPayload());
    }

    if (!user) {
      user = new User({
        name: doc.fullName,
        email: doc.email,
        phone: doc.mobileNumber,
        password,
        userType: 'wholesaler',
        role: 'wholesaler',
        status: 'active',
        isPhoneVerified: true,
        isEmailVerified: false,
        registrationMethod: 'phone',
        isProfileComplete: true,
        lastLoginMethod: 'otp'
      });
    } else {
      user.name = user.name || doc.fullName;
      user.email = user.email || doc.email;
      user.phone = user.phone || doc.mobileNumber;
      user.password = password;
      user.userType = 'wholesaler';
      user.role = 'wholesaler';
      user.status = 'active';
      user.isPhoneVerified = true;
      user.isProfileComplete = true;
      user.lastLoginMethod = 'otp';
    }

    const accessToken = generateAccessToken(user._id, user.userType, user.role, 'wholesale');
    const refreshToken = generateRefreshToken(user._id);
    const hashedRefreshToken = hashString(refreshToken);

    user.refreshTokens = user.refreshTokens || [];
    user.refreshTokens = user.refreshTokens.filter((t) => t.expiresAt > new Date());
    user.refreshTokens.push({
      token: hashedRefreshToken,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      createdAt: new Date(),
      deviceInfo: req.headers['user-agent'] || 'Unknown'
    });
    await user.save();

    doc.status = 'activated';
    doc.linkedUserId = user._id;
    doc.activatedAt = new Date();
    doc.activationOtpHash = null;
    doc.activationOtpExpiresAt = null;
    doc.activationOtpAttempts = 0;
    await doc.save();

    setRefreshTokenCookie(req, res, 'wholesale', refreshToken);

    return res.status(200).json({
      success: true,
      message: 'Wholesaler account activated and logged in successfully',
      accessToken,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        userType: user.userType,
        role: user.role
      }
    });
  } catch (error) {
    return authContractError(res, 500, 'WHOLESALER_ACTIVATION_VERIFY_FAILED', 'Error verifying activation OTP');
  }
};
