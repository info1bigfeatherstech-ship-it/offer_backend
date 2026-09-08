/**
 * Build a landscape "contain + pad" preview for web-push `image` slots.
 *
 * Chrome/Windows notification heroes are wide; portrait product shots get
 * cropped. This helper letterboxes the product on a solid background so the
 * full item stays visible.
 *
 * Soft-fail: returns null on any error (callers should omit `image`).
 */
const crypto = require('crypto');
const sharp = require('sharp');
const logger = require('./logger');
const {
  isR2Configured,
  uploadBufferToR2,
  r2ObjectExists,
  buildPublicUrl,
} = require('./r2Storage');

const DEFAULT_WIDTH = 1200;
const DEFAULT_HEIGHT = 630; // ~1.91:1 — notification-friendly landscape
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 12_000;

function envFlagEnabled(name, defaultEnabled = true) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return defaultEnabled;
  const v = String(raw).trim().toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  return defaultEnabled;
}

function resolveCanvasSize() {
  const width = Math.min(
    1600,
    Math.max(600, Number(process.env.PUSH_LANDSCAPE_WIDTH || DEFAULT_WIDTH) || DEFAULT_WIDTH)
  );
  const height = Math.min(
    900,
    Math.max(300, Number(process.env.PUSH_LANDSCAPE_HEIGHT || DEFAULT_HEIGHT) || DEFAULT_HEIGHT)
  );
  return { width: Math.floor(width), height: Math.floor(height) };
}

function resolveHttpsUrl(raw) {
  const value = String(raw || '').trim();
  if (!value || value.length > 2048) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function contentAddressedKey(sourceUrl, width, height) {
  const hash = crypto
    .createHash('sha256')
    .update(`${sourceUrl}|${width}x${height}|v1`)
    .digest('hex')
    .slice(0, 40);
  return `push-previews/landscape/${width}x${height}/${hash}.webp`;
}

async function fetchImageBuffer(sourceUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(sourceUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'User-Agent': 'OfferWaleBaba-PushPreview/1.0',
      },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const lenHeader = Number(res.headers.get('content-length') || 0);
    if (Number.isFinite(lenHeader) && lenHeader > MAX_SOURCE_BYTES) {
      throw new Error('Source image too large');
    }
    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);
    if (!buf.length || buf.length > MAX_SOURCE_BYTES) {
      throw new Error('Source image empty or too large');
    }
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Letterbox product photo into a landscape canvas (contain + pad).
 * @param {Buffer} sourceBuffer
 * @param {{ width: number, height: number }} size
 */
async function renderLandscapePreview(sourceBuffer, size) {
  const { width, height } = size;
  const background = { r: 255, g: 255, b: 255, alpha: 1 };

  // Auto-orient EXIF, then fit inside canvas without cropping.
  return sharp(sourceBuffer, { failOn: 'none' })
    .rotate()
    .resize(width, height, {
      fit: 'contain',
      background,
      withoutEnlargement: false,
    })
    .webp({ quality: 82, effort: 4 })
    .toBuffer();
}

/**
 * Ensure a public https URL for a landscape push preview of `sourceImageUrl`.
 * Cached on R2 by content hash. Returns null on soft failure.
 *
 * @param {unknown} sourceImageUrl
 * @param {{ logTag?: string }} [options]
 * @returns {Promise<string|null>}
 */
async function resolveLandscapePushImageUrl(sourceImageUrl, options = {}) {
  const logTag = options.logTag || 'pushLandscapePreview';

  if (!envFlagEnabled('PUSH_LANDSCAPE_PREVIEW_ENABLED', true)) {
    return null;
  }

  const sourceUrl = resolveHttpsUrl(sourceImageUrl);
  if (!sourceUrl) return null;

  if (!isR2Configured()) {
    logger.info(`[${logTag}] R2 not configured — skipping landscape preview`);
    return null;
  }

  const { width, height } = resolveCanvasSize();
  const objectKey = contentAddressedKey(sourceUrl, width, height);
  const cachedUrl = buildPublicUrl(objectKey);

  try {
    if (await r2ObjectExists(objectKey)) {
      return cachedUrl;
    }
  } catch (err) {
    logger.warn(`[${logTag}] cache head failed`, { message: err?.message || String(err) });
  }

  try {
    const sourceBuffer = await fetchImageBuffer(sourceUrl);
    const previewBuffer = await renderLandscapePreview(sourceBuffer, { width, height });
    if (!previewBuffer?.length) {
      throw new Error('Empty preview buffer');
    }

    const upload = await uploadBufferToR2({
      buffer: previewBuffer,
      objectKey,
      contentType: 'image/webp',
      extension: 'webp',
      cacheControl: 'public, max-age=31536000, immutable',
    });

    return upload.url || cachedUrl;
  } catch (err) {
    logger.warn(`[${logTag}] landscape preview failed`, {
      sourceHost: (() => {
        try {
          return new URL(sourceUrl).host;
        } catch {
          return null;
        }
      })(),
      message: err?.message || String(err),
    });
    return null;
  }
}

module.exports = {
  resolveLandscapePushImageUrl,
  renderLandscapePreview,
  resolveHttpsUrl,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
};
