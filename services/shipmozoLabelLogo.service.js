  /**
 * Per-storefront Shipmozo label logo — Cloudinary upload/delete.
 * Ecomm and wholesale logos are isolated (separate DB docs + folders).
 */

const sharp = require('sharp');
const { cloudinary } = require('../config/cloudinary.config');
const logger = require('../utils/logger');
const ShipmozoLabelSettings = require('../models/ShipmozoLabelSettings');
const {
  normalizeStorefront,
  defaultSettings,
  sanitizeSettings,
  isAllowedLogoUrl
} = require('./shipmozoLabelSettings.service');

const LABEL_LOGO_MAX_BYTES = 1024 * 1024;
const LABEL_LOGO_MAX_WIDTH = 600;
const LABEL_LOGO_WEBP_QUALITY = 82;

function isAllowedLogoUrlLocal(url) {
  return isAllowedLogoUrl(url);
}

function labelLogoActive(settings) {
  const b = settings?.branding || {};
  return Boolean(b.showLogo && isAllowedLogoUrlLocal(b.logoUrl));
}

async function optimizeLabelLogoBuffer(buffer) {
  return sharp(buffer)
    .rotate()
    .resize({
      width: LABEL_LOGO_MAX_WIDTH,
      height: LABEL_LOGO_MAX_WIDTH,
      fit: 'inside',
      withoutEnlargement: true
    })
    .webp({ quality: LABEL_LOGO_WEBP_QUALITY, effort: 4 })
    .toBuffer();
}

async function deleteCloudinaryLogo(publicId) {
  const id = String(publicId || '').trim();
  if (!id) return;
  try {
    await cloudinary.uploader.destroy(id, { resource_type: 'image' });
  } catch (err) {
    logger.warn('shipmozo label logo cloudinary destroy failed', {
      publicId: id,
      message: err?.message
    });
  }
}

async function uploadToCloudinary(buffer, storefront) {
  const sf = normalizeStorefront(storefront);
  const publicId = `logo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return new Promise((resolve, reject) => {
    const uploadOptions = {
      folder: `shipmozo-label-logos/${sf}`,
      resource_type: 'image',
      public_id: publicId,
      format: 'webp',
      overwrite: false
    };

    const stream = cloudinary.uploader.upload_stream(uploadOptions, (error, result) => {
      if (error) {
        reject(new Error(error.message || 'Logo upload failed'));
        return;
      }
      resolve({
        url: result.secure_url,
        publicId: result.public_id
      });
    });
    stream.end(buffer);
  });
}

async function getDoc(storefront) {
  const sf = normalizeStorefront(storefront);
  let doc = await ShipmozoLabelSettings.findOne({ storefront: sf });
  if (!doc) {
    doc = await ShipmozoLabelSettings.create({
      storefront: sf,
      settings: defaultSettings()
    });
  }
  return doc;
}

/**
 * Upload/replace label logo for one storefront.
 * @param {string} storefront
 * @param {Buffer} fileBuffer
 * @param {string|null} updatedBy
 */
async function uploadLabelLogo(storefront, fileBuffer, updatedBy) {
  const sf = normalizeStorefront(storefront);
  if (!fileBuffer || !Buffer.isBuffer(fileBuffer) || fileBuffer.length < 32) {
    throw new Error('Logo file is empty or invalid');
  }
  if (fileBuffer.length > LABEL_LOGO_MAX_BYTES) {
    throw new Error('Logo must be 1 MB or smaller');
  }

  const doc = await getDoc(sf);
  const prevPublicId = String(doc.settings?.branding?.logoPublicId || '').trim();

  let optimized;
  try {
    optimized = await optimizeLabelLogoBuffer(fileBuffer);
  } catch (err) {
    throw new Error(`Logo could not be processed: ${err?.message || err}`);
  }

  let uploaded;
  try {
    uploaded = await uploadToCloudinary(optimized, sf);
  } catch (err) {
    throw new Error(err.message || 'Cloudinary upload failed');
  }

  const settings = sanitizeSettings(doc.settings || {});
  settings.branding = {
    ...settings.branding,
    logoUrl: uploaded.url,
    logoPublicId: uploaded.publicId,
    showLogo: true
  };

  await ShipmozoLabelSettings.findOneAndUpdate(
    { storefront: sf },
    { $set: { settings, updatedBy: updatedBy || null } },
    { upsert: true, new: true }
  );

  if (prevPublicId && prevPublicId !== uploaded.publicId) {
    await deleteCloudinaryLogo(prevPublicId);
  }

  return {
    storefront: sf,
    logoUrl: uploaded.url,
    logoPublicId: uploaded.publicId,
    settings
  };
}

/**
 * Remove stored logo for one storefront (Cloudinary + DB).
 */
async function removeLabelLogo(storefront, updatedBy) {
  const sf = normalizeStorefront(storefront);
  const doc = await getDoc(sf);
  const prevPublicId = String(doc.settings?.branding?.logoPublicId || '').trim();

  const settings = sanitizeSettings(doc.settings || {});
  settings.branding = {
    ...settings.branding,
    logoUrl: '',
    logoPublicId: '',
    showLogo: false
  };

  await ShipmozoLabelSettings.findOneAndUpdate(
    { storefront: sf },
    { $set: { settings, updatedBy: updatedBy || null } },
    { upsert: true, new: true }
  );

  if (prevPublicId) {
    await deleteCloudinaryLogo(prevPublicId);
  }

  return { storefront: sf, settings };
}

module.exports = {
  LABEL_LOGO_MAX_BYTES,
  labelLogoActive,
  uploadLabelLogo,
  removeLabelLogo,
  deleteCloudinaryLogo
};
