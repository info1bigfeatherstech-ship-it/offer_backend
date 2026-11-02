/**
 * Compress gift-enquiry images, then store on the same default media provider
 * as product images (Cloudflare R2 or Cloudinary). PDFs are stored raw.
 */

const crypto = require('crypto');
const path = require('path');
const logger = require('../utils/logger');
const {
  optimizeProductImageBuffer,
  uploadToCloudinary,
  uploadRawToDefaultMedia,
  deleteFromCloudinary,
  isDefaultMediaConfigured,
} = require('../utils/cloudinaryHelper');
const {
  detectBufferKind,
  isAllowedLogoKind,
  isAllowedReferenceKind,
} = require('../utils/giftEnquiryFileSignature');
const {
  MAX_GIFT_FILE_BYTES,
  MAX_REFERENCE_PHOTOS,
  MAX_LOGOS,
  MAX_BUSINESS_CARDS,
  createHttpError,
} = require('../utils/corporateGiftEnquiryValidation');

function collectFieldFiles(req, field) {
  const files = req.files && req.files[field];
  return Array.isArray(files) ? files.filter(Boolean) : [];
}

function sanitizeOriginalName(name) {
  const base = path.basename(String(name || 'file'));
  return base.replace(/[^\w.\-]+/g, '_').slice(0, 180) || 'file';
}

function sanitizePublicIdPart(value) {
  return (
    String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50) || 'file'
  );
}

function fileTypeMessage(field, allowPdf) {
  if (field === 'businessCard') {
    return 'Business card must be an image (JPG, JPEG, PNG, WEBP) or PDF.';
  }
  if (allowPdf) {
    return 'Logo files must be images (JPG, JPEG, PNG, WEBP) or PDF.';
  }
  return 'Reference photos must be image files (JPG, JPEG, PNG, WEBP). PDF is not allowed.';
}

function assertFileBuffer(file, field) {
  if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
    throw createHttpError(400, 'INVALID_FILE_TYPE', 'Uploaded file is empty or unreadable', field);
  }
  if (file.buffer.length > MAX_GIFT_FILE_BYTES) {
    throw createHttpError(400, 'FILE_TOO_LARGE', 'Each file must be 20 MB or smaller', field);
  }
}

function inspectFile(file, { allowedKinds, field, allowPdf }) {
  assertFileBuffer(file, field);
  const kind = detectBufferKind(file.buffer);
  if (!kind || !allowedKinds(kind)) {
    throw createHttpError(400, 'INVALID_FILE_TYPE', fileTypeMessage(field, allowPdf), field);
  }
  return kind;
}

function resourceTypeForAsset(asset) {
  return asset?.mimeType === 'application/pdf' ? 'raw' : undefined;
}

async function rollbackUploads(assets) {
  for (const asset of assets) {
    if (!asset?.publicId) continue;
    try {
      await deleteFromCloudinary(asset.publicId, resourceTypeForAsset(asset));
    } catch (err) {
      logger.error('[gift-enquiry] media rollback failed', {
        publicId: asset.publicId,
        message: err.message,
      });
    }
  }
}

async function uploadOneFile(file, { kind, folder, publicIdPrefix, assetKind }) {
  const originalName = sanitizeOriginalName(file.originalname);
  const publicIdName = `${sanitizePublicIdPart(publicIdPrefix)}-${Date.now()}-${crypto
    .randomBytes(4)
    .toString('hex')}`;

  if (kind === 'pdf') {
    const upload = await uploadRawToDefaultMedia(file.buffer, folder, publicIdName);
    return {
      url: upload.url,
      publicId: upload.publicId,
      originalName,
      mimeType: 'application/pdf',
      sizeBytes: file.buffer.length,
      kind: assetKind,
    };
  }

  let optimized;
  try {
    optimized = await optimizeProductImageBuffer(file.buffer);
  } catch (err) {
    logger.warn('[gift-enquiry] image compress failed', { message: err.message });
    const field =
      assetKind === 'logo' ? 'logos' : assetKind === 'business_card' ? 'businessCard' : 'referencePhotos';
    throw createHttpError(
      400,
      'INVALID_FILE_TYPE',
      'Could not process this image. Use JPG, PNG, or WEBP.',
      field
    );
  }

  const upload = await uploadToCloudinary(optimized, folder, publicIdName);
  return {
    url: upload.url,
    publicId: upload.publicId,
    originalName,
    mimeType: 'image/webp',
    sizeBytes: optimized.length,
    kind: assetKind,
  };
}

function pickEnquiryFiles(req) {
  return {
    referencePhotos: collectFieldFiles(req, 'referencePhotos'),
    logos: collectFieldFiles(req, 'logos'),
    businessCards: collectFieldFiles(req, 'businessCard'),
  };
}

function validateEnquiryFiles(enquiryType, files) {
  const refs = files.referencePhotos || [];
  const logos = files.logos || [];
  const cards = files.businessCards || [];

  if (enquiryType === 'bulk') {
    if (refs.length > 0 || logos.length > 0) {
      throw createHttpError(
        400,
        'FILES_NOT_ALLOWED',
        'Bulk enquiries cannot include logo or reference files.',
        'files'
      );
    }
    if (cards.length > MAX_BUSINESS_CARDS) {
      throw createHttpError(
        400,
        'TOO_MANY_FILES',
        'Only 1 business card file is allowed.',
        'businessCard'
      );
    }
    const inspectedCards = cards.map((file) => ({
      file,
      kind: inspectFile(file, {
        allowedKinds: isAllowedLogoKind,
        field: 'businessCard',
        allowPdf: true,
      }),
    }));
    return { inspectedRefs: [], inspectedLogos: [], inspectedCards };
  }

  if (cards.length > 0) {
    throw createHttpError(
      400,
      'FILES_NOT_ALLOWED',
      'Customised gift enquiries cannot include a business card.',
      'businessCard'
    );
  }
  if (refs.length > MAX_REFERENCE_PHOTOS) {
    throw createHttpError(
      400,
      'TOO_MANY_FILES',
      'Maximum 6 reference photos are allowed.',
      'referencePhotos'
    );
  }
  if (logos.length > MAX_LOGOS) {
    throw createHttpError(400, 'TOO_MANY_FILES', 'Maximum 3 logo files are allowed.', 'logos');
  }

  return {
    inspectedRefs: refs.map((file) => ({
      file,
      kind: inspectFile(file, {
        allowedKinds: isAllowedReferenceKind,
        field: 'referencePhotos',
        allowPdf: false,
      }),
    })),
    inspectedLogos: logos.map((file) => ({
      file,
      kind: inspectFile(file, {
        allowedKinds: isAllowedLogoKind,
        field: 'logos',
        allowPdf: true,
      }),
    })),
    inspectedCards: [],
  };
}

function collectJobs(payload, inspected) {
  const prefix = payload.phone || 'enquiry';
  const jobs = [];
  for (const item of inspected.inspectedRefs || []) {
    jobs.push({
      file: item.file,
      kind: item.kind,
      folder: 'gift-enquiries/references',
      publicIdPrefix: `ref-${prefix}`,
      assetKind: 'reference',
    });
  }
  for (const item of inspected.inspectedLogos || []) {
    jobs.push({
      file: item.file,
      kind: item.kind,
      folder: 'gift-enquiries/logos',
      publicIdPrefix: `logo-${prefix}`,
      assetKind: 'logo',
    });
  }
  for (const item of inspected.inspectedCards || []) {
    jobs.push({
      file: item.file,
      kind: item.kind,
      folder: 'gift-enquiries/business-cards',
      publicIdPrefix: `card-${prefix}`,
      assetKind: 'business_card',
    });
  }
  return jobs;
}

/**
 * Upload enquiry files to the default product media provider.
 * Caller must rollback if DB write fails.
 */
async function uploadEnquiryAssets(payload, files) {
  const inspected = validateEnquiryFiles(payload.enquiryType, files);
  const jobs = collectJobs(payload, inspected);

  if (!jobs.length) {
    return { logos: [], referencePhotos: [], businessCard: null };
  }

  if (!isDefaultMediaConfigured()) {
    throw createHttpError(
      503,
      'MEDIA_STORAGE_UNAVAILABLE',
      'File storage is temporarily unavailable. Please try again shortly.'
    );
  }

  const uploaded = [];
  try {
    for (const job of jobs) {
      const asset = await uploadOneFile(job.file, job);
      uploaded.push(asset);
    }
  } catch (err) {
    await rollbackUploads(uploaded);
    throw err;
  }

  return {
    referencePhotos: uploaded.filter((a) => a.kind === 'reference'),
    logos: uploaded.filter((a) => a.kind === 'logo'),
    businessCard: uploaded.find((a) => a.kind === 'business_card') || null,
  };
}

module.exports = {
  pickEnquiryFiles,
  validateEnquiryFiles,
  uploadEnquiryAssets,
  rollbackUploads,
};
