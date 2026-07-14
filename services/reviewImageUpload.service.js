const { cloudinary } = require('../config/cloudinary.config');
const { optimizeProductImageBuffer } = require('../utils/cloudinaryHelper');

const MAX_REVIEW_IMAGES = 5;

/** Review photos: smaller than PDP product shots to save Cloudinary quota. */
const REVIEW_IMAGE_MAX_WIDTH = 1200;
const REVIEW_IMAGE_QUALITY = 72;

/**
 * Compress locally (sharp → WebP) then upload to Cloudinary.
 * Folder: reviews/{orderId|productId}/{userId}/
 *
 * @param {import('express').Multer.File} file
 * @param {{ productId: string, userId: string, orderId?: string|null }} ctx
 */
async function uploadReviewImageToCloudinary(file, ctx) {
  const folderKey = String(ctx.orderId || ctx.productId || 'general').replace(
    /[^\w-]/g,
    '_'
  );
  const userKey = String(ctx.userId || 'user').replace(/[^\w-]/g, '_');

  let optimized;
  try {
    optimized = await optimizeProductImageBuffer(file.buffer, {
      maxWidth: REVIEW_IMAGE_MAX_WIDTH,
      quality: REVIEW_IMAGE_QUALITY,
      effort: 5
    });
  } catch (err) {
    throw new Error(
      `Review image compress failed: ${err?.message || err}`
    );
  }

  return new Promise((resolve, reject) => {
    const uploadOptions = {
      folder: `reviews/${folderKey}/${userKey}`,
      resource_type: 'image',
      public_id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      format: 'webp',
      // Already compressed client-side; keep store lean
      transformation: [{ quality: 'auto:good', fetch_format: 'webp' }]
    };

    const stream = cloudinary.uploader.upload_stream(
      uploadOptions,
      (error, result) => {
        if (error) {
          reject(new Error(`Review image upload failed: ${error.message}`));
          return;
        }
        resolve({
          url: result.secure_url,
          publicId: result.public_id
        });
      }
    );
    stream.end(optimized);
  });
}

/**
 * @param {string|null|undefined} publicId
 */
async function deleteReviewImageFromCloudinary(publicId) {
  const id = String(publicId || '').trim();
  if (!id) return;
  try {
    await cloudinary.uploader.destroy(id, { resource_type: 'image' });
  } catch (err) {
    console.warn('[deleteReviewImageFromCloudinary]', id, err?.message || err);
  }
}

/**
 * @param {Array<{ publicId?: string|null }>} images
 */
async function deleteReviewImagesFromCloudinary(images) {
  const list = Array.isArray(images) ? images : [];
  await Promise.all(
    list.map((img) => deleteReviewImageFromCloudinary(img?.publicId))
  );
}

/**
 * @param {import('express').Multer.File[]} files
 * @param {{ productId: string, userId: string, orderId?: string|null }} ctx
 */
async function uploadReviewImages(files, ctx) {
  const safeFiles = Array.isArray(files) ? files.filter((f) => f?.buffer) : [];
  if (!safeFiles.length) return [];

  const uploaded = [];
  try {
    for (const file of safeFiles) {
      const row = await uploadReviewImageToCloudinary(file, ctx);
      uploaded.push(row);
    }
    return uploaded;
  } catch (err) {
    await deleteReviewImagesFromCloudinary(uploaded);
    throw err;
  }
}

function normalizeStoredImages(images) {
  if (!Array.isArray(images)) return [];
  return images
    .filter((img) => img && img.url)
    .map((img) => ({
      url: String(img.url),
      publicId: img.publicId ? String(img.publicId) : null
    }));
}

function parseRemoveImagePublicIds(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map((id) => String(id || '').trim()).filter(Boolean);
  }
  const str = String(raw).trim();
  if (!str) return [];
  try {
    const parsed = JSON.parse(str);
    if (Array.isArray(parsed)) {
      return parsed.map((id) => String(id || '').trim()).filter(Boolean);
    }
  } catch {
    return str.split(',').map((id) => id.trim()).filter(Boolean);
  }
  return [];
}

module.exports = {
  MAX_REVIEW_IMAGES,
  REVIEW_IMAGE_MAX_WIDTH,
  REVIEW_IMAGE_QUALITY,
  uploadReviewImages,
  deleteReviewImageFromCloudinary,
  deleteReviewImagesFromCloudinary,
  normalizeStoredImages,
  parseRemoveImagePublicIds
};
