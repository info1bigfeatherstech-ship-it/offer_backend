const crypto = require('crypto');
const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3');

let r2Client = null;

function normalizeBool(value, fallback = false) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return fallback;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function requireEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function isR2Configured() {
  return Boolean(
    String(process.env.R2_ENDPOINT || '').trim() &&
      String(process.env.R2_ACCESS_KEY_ID || '').trim() &&
      String(process.env.R2_SECRET_ACCESS_KEY || '').trim() &&
      String(process.env.R2_BUCKET_NAME || '').trim() &&
      String(process.env.R2_PUBLIC_BASE_URL || '').trim()
  );
}

function buildClient() {
  const endpoint = requireEnv('R2_ENDPOINT');
  const accessKeyId = requireEnv('R2_ACCESS_KEY_ID');
  const secretAccessKey = requireEnv('R2_SECRET_ACCESS_KEY');
  const region = String(process.env.R2_REGION || 'auto').trim() || 'auto';
  const forcePathStyle = normalizeBool(process.env.R2_FORCE_PATH_STYLE, true);

  return new S3Client({
    region,
    endpoint,
    forcePathStyle,
    credentials: { accessKeyId, secretAccessKey },
  });
}

function getClient() {
  if (!r2Client) {
    r2Client = buildClient();
  }
  return r2Client;
}

function sanitizePathPart(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/[^a-zA-Z0-9/_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/\/+/g, '/')
    .replace(/^\/|\/$/g, '')
    .slice(0, 300);
}

function buildObjectKey(folderPath, publicIdName, extension = 'webp') {
  const folder = sanitizePathPart(folderPath) || 'media';
  const safeBase = sanitizePathPart(publicIdName) || crypto.randomUUID();
  const ext = String(extension || 'webp').replace(/^\./, '').toLowerCase();
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${folder}/${year}/${month}/${safeBase}.${ext}`;
}

function getBucketName() {
  return requireEnv('R2_BUCKET_NAME');
}

function getPublicBaseUrl() {
  return String(requireEnv('R2_PUBLIC_BASE_URL')).replace(/\/$/, '');
}

function buildPublicUrl(key) {
  const base = getPublicBaseUrl();
  const safeKey = String(key || '').replace(/^\/+/, '');
  return `${base}/${safeKey}`;
}

async function uploadBufferToR2({
  buffer,
  folderPath,
  publicIdName,
  contentType = 'application/octet-stream',
  extension = 'bin',
  cacheControl = 'public, max-age=31536000, immutable',
  /** When set, skips dated folder layout — use for content-addressed caches. */
  objectKey = null,
}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('Invalid upload buffer for R2');
  }

  const bucket = getBucketName();
  const key = objectKey
    ? String(objectKey).replace(/^\/+/, '').slice(0, 500)
    : buildObjectKey(folderPath, publicIdName, extension);

  if (!key) {
    throw new Error('Invalid R2 object key');
  }

  const putCommand = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    CacheControl: cacheControl,
  });

  await getClient().send(putCommand);
  return {
    key,
    url: buildPublicUrl(key),
  };
}

/**
 * Soft existence check for a key (404 → false; other errors → false).
 */
async function r2ObjectExists(key) {
  const normalizedKey = String(key || '').trim().replace(/^\/+/, '');
  if (!normalizedKey || !isR2Configured()) return false;
  try {
    await getClient().send(
      new HeadObjectCommand({
        Bucket: getBucketName(),
        Key: normalizedKey,
      })
    );
    return true;
  } catch (err) {
    const status = err?.$metadata?.httpStatusCode || err?.statusCode;
    if (status === 404 || err?.name === 'NotFound' || err?.Code === 'NotFound') {
      return false;
    }
    return false;
  }
}

function parseR2KeyFromUrl(url) {
  const value = String(url || '').trim();
  if (!value) return null;
  try {
    const base = getPublicBaseUrl();
    if (!value.startsWith(base)) return null;
    return value.slice(base.length).replace(/^\/+/, '');
  } catch {
    return null;
  }
}

async function deleteFromR2ByKey(key) {
  const normalizedKey = String(key || '').trim().replace(/^\/+/, '');
  if (!normalizedKey) return;

  const bucket = getBucketName();
  const delCommand = new DeleteObjectCommand({
    Bucket: bucket,
    Key: normalizedKey,
  });
  await getClient().send(delCommand);
}

async function deleteFromR2ByUrl(url) {
  const key = parseR2KeyFromUrl(url);
  if (!key) return;
  await deleteFromR2ByKey(key);
}

module.exports = {
  isR2Configured,
  uploadBufferToR2,
  r2ObjectExists,
  deleteFromR2ByKey,
  deleteFromR2ByUrl,
  parseR2KeyFromUrl,
  buildPublicUrl,
};
