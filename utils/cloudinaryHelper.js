const sharp = require('sharp');
const { cloudinary } = require('../config/cloudinary.config');
const { uploadBufferToR2, deleteFromR2ByKey } = require('./r2Storage');

const DEFAULT_MAX_WIDTH = Math.min(
  4096,
  Math.max(256, Number(process.env.PRODUCT_IMAGE_MAX_WIDTH) || 1500)
);
const DEFAULT_WEBP_QUALITY = Math.min(
  100,
  Math.max(50, Number(process.env.PRODUCT_IMAGE_WEBP_QUALITY) || 82)
);
const DEFAULT_WEBP_EFFORT = Math.min(
  6,
  Math.max(0, Number(process.env.PRODUCT_IMAGE_WEBP_EFFORT) || 4)
);

/** Longest side ≤ this and input bytes ≤ GENTLE_MAX_BYTES → gentle tier (no resize, high WebP quality). */
const GENTLE_MAX_EDGE = Math.min(
  4096,
  Math.max(256, Number(process.env.PRODUCT_IMAGE_GENTLE_MAX_EDGE) || 1280)
);
const GENTLE_MAX_BYTES = Math.min(
  20 * 1024 * 1024,
  Math.max(1024, Number(process.env.PRODUCT_IMAGE_GENTLE_MAX_BYTES) || 524288)
);
const GENTLE_WEBP_QUALITY = Math.min(
  100,
  Math.max(70, Number(process.env.PRODUCT_IMAGE_GENTLE_WEBP_QUALITY) || 93)
);
const GENTLE_WEBP_EFFORT = Math.min(
  6,
  Math.max(0, Number(process.env.PRODUCT_IMAGE_GENTLE_WEBP_EFFORT) || 2)
);

/**
 * Whether caller supplied an explicit encode profile (bypass auto tiering).
 * Category tiles pass maxWidth / quality; those must not use "gentle" auto.
 */
function hasExplicitPipelineOptions(options) {
  return (
    options.maxWidth != null ||
    options.quality != null ||
    options.effort != null ||
    options.pipeline === 'full' ||
    options.pipeline === 'gentle'
  );
}

function resolvePipelineMode(options) {
  if (options.pipeline === 'full' || options.pipeline === 'gentle') {
    return options.pipeline;
  }
  const env = (process.env.PRODUCT_IMAGE_PIPELINE_MODE || 'auto').toLowerCase();
  if (env === 'full' || env === 'gentle') return env;
  return 'auto';
}

/**
 * Production pipeline: EXIF-aware rotate, optional width cap, WebP before Cloudinary.
 *
 * **Auto tiering (default for products):** small catalog-style assets (both longest edge and
 * byte size below thresholds) use a *gentle* path (no resize, higher WebP quality) to avoid
 * double-crushing supplier thumbnails (e.g. 500×500 WebP). Larger or heavier files use the
 * *full* path (resize + standard WebP). Callers that pass `maxWidth` / `quality` / `effort` or
 * `pipeline: 'full'|'gentle'` always get deterministic behaviour (no auto).
 *
 * Env: `PRODUCT_IMAGE_MAX_WIDTH`, `PRODUCT_IMAGE_WEBP_QUALITY`, `PRODUCT_IMAGE_WEBP_EFFORT`,
 * `PRODUCT_IMAGE_PIPELINE_MODE` (`auto`|`full`|`gentle`),
 * `PRODUCT_IMAGE_GENTLE_MAX_EDGE`, `PRODUCT_IMAGE_GENTLE_MAX_BYTES`,
 * `PRODUCT_IMAGE_GENTLE_WEBP_QUALITY`, `PRODUCT_IMAGE_GENTLE_WEBP_EFFORT`.
 *
 * @param {Buffer|ArrayBuffer|Uint8Array} input
 * @param {{
 *   maxWidth?: number,
 *   quality?: number,
 *   effort?: number,
 *   pipeline?: 'auto' | 'full' | 'gentle'
 * }} [options]
 * @returns {Promise<Buffer>}
 */
async function optimizeProductImageBuffer(input, options = {}) {
  let buf;
  if (Buffer.isBuffer(input)) {
    buf = input;
  } else if (input instanceof ArrayBuffer) {
    buf = Buffer.from(input);
  } else if (input && input.buffer instanceof ArrayBuffer) {
    buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  } else {
    throw new TypeError('optimizeProductImageBuffer: expected Buffer or array-backed bytes');
  }

  if (!buf.length) {
    throw new Error('optimizeProductImageBuffer: empty buffer');
  }

  const maxWidth = options.maxWidth ?? DEFAULT_MAX_WIDTH;
  const quality = options.quality ?? DEFAULT_WEBP_QUALITY;
  const effort = options.effort ?? DEFAULT_WEBP_EFFORT;

  const sharpInput = { animated: true, limitInputPixels: 268_402_689 };

  const runGentle = () =>
    sharp(buf, sharpInput)
      .rotate()
      .webp({
        quality: options.quality ?? GENTLE_WEBP_QUALITY,
        effort: options.effort ?? GENTLE_WEBP_EFFORT,
        smartSubsample: true
      })
      .toBuffer();

  const runFull = () =>
    sharp(buf, sharpInput)
      .rotate()
      .resize({ width: maxWidth, withoutEnlargement: true })
      .webp({ quality, effort, smartSubsample: true })
      .toBuffer();

  try {
    const mode = resolvePipelineMode(options);

    if (hasExplicitPipelineOptions(options)) {
      if (options.pipeline === 'gentle') {
        return await runGentle();
      }
      return await runFull();
    }

    if (mode === 'gentle') {
      return await runGentle();
    }
    if (mode === 'full') {
      return await runFull();
    }

    // auto (default): choose tier from metadata + size
    let metadata;
    try {
      metadata = await sharp(buf, sharpInput).metadata();
    } catch {
      return await runFull();
    }

    const w = metadata.width || 0;
    const h = metadata.height || 0;
    const longest = Math.max(w, h);
    const pages = metadata.pages || 1;

    const isMultiFrame = pages > 1;
    const fitsGentlePixel = longest > 0 && longest <= GENTLE_MAX_EDGE;
    const fitsGentleBytes = buf.length <= GENTLE_MAX_BYTES;

    const useGentle =
      !isMultiFrame && fitsGentlePixel && fitsGentleBytes;

    if (useGentle) {
      return await sharp(buf, sharpInput)
        .rotate()
        .webp({
          quality: GENTLE_WEBP_QUALITY,
          effort: GENTLE_WEBP_EFFORT,
          smartSubsample: true
        })
        .toBuffer();
    }

    return await runFull();
  } catch (err) {
    const wrapped = new Error(`Image optimization failed: ${err.message}`);
    wrapped.cause = err;
    throw wrapped;
  }
}

function getDefaultMediaProvider() {
  const mode = String(process.env.MEDIA_STORAGE_MODE || '').trim().toLowerCase();
  const explicit = String(process.env.MEDIA_PROVIDER_DEFAULT || '').trim().toLowerCase();
  if (explicit === 'r2' || explicit === 'cloudinary') return explicit;
  if (mode === 'hybrid') return 'r2';
  return 'cloudinary';
}

function uploadImageToCloudinary(fileBuffer, folderPath = 'products', publicIdName = null) {
  return new Promise((resolve, reject) => {
    const opts = {
      folder: folderPath,
      resource_type: 'image',
      format: 'webp', // Force WebP storage
      transformation: [
        { quality: 'auto' }
      ]
    };

    if (publicIdName) {
      opts.public_id = publicIdName;
    }

    const stream = cloudinary.uploader.upload_stream(
      opts,
      (error, result) => {
        if (error) {
          reject(new Error(`Cloudinary upload error: ${error.message}`));
        } else {
          resolve({
            url: result.secure_url,
            publicId: result.public_id
          });
        }
      }
    );

    stream.end(fileBuffer);
  });
}

/**
 * Backward-compatible uploader used by product/category controllers.
 * In hybrid/default-r2 mode this stores to Cloudflare R2, otherwise Cloudinary.
 * @returns {Promise<{url: String, publicId: String}>}
 */
const uploadToCloudinary = async (fileBuffer, folderPath = 'products', publicIdName = null) => {
  const provider = getDefaultMediaProvider();

  if (provider === 'r2') {
    const upload = await uploadBufferToR2({
      buffer: fileBuffer,
      folderPath,
      publicIdName: publicIdName || `img-${Date.now()}`,
      contentType: 'image/webp',
      extension: 'webp'
    });
    return {
      url: upload.url,
      publicId: `r2:${upload.key}`
    };
  }

  return uploadImageToCloudinary(fileBuffer, folderPath, publicIdName);
};



/**
 * Delete image from Cloudinary
 * @param {String} publicId - Cloudinary public ID
 */
const deleteFromCloudinary = async (publicId) => {
  try {
    if (String(publicId || '').startsWith('r2:')) {
      const key = String(publicId).slice(3);
      await deleteFromR2ByKey(key);
      return;
    }
    await cloudinary.uploader.destroy(publicId);
  } catch (error) {
    console.error('Failed to delete image from Cloudinary:', error.message);
  }
};

module.exports = {
  uploadToCloudinary,
  deleteFromCloudinary,
  optimizeProductImageBuffer
};
