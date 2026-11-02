/**
 * Magic-byte detection for gift-enquiry uploads.
 * MIME from the client is not trusted.
 */

const IMAGE_KINDS = new Set(['jpeg', 'png', 'webp', 'gif', 'bmp', 'tiff', 'heic', 'avif']);
const LOGO_KINDS = new Set([...IMAGE_KINDS, 'pdf']);
const REFERENCE_KINDS = IMAGE_KINDS;

function detectBufferKind(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return 'png';
  }
  if (
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }
  if (buffer.toString('ascii', 0, 4) === '%PDF') return 'pdf';
  if (buffer.toString('ascii', 0, 3) === 'GIF') return 'gif';
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return 'bmp';
  if (
    (buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00) ||
    (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a)
  ) {
    return 'tiff';
  }

  if (buffer.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buffer.toString('ascii', 8, 12).toLowerCase();
    if (['heic', 'heif', 'mif1', 'msf1'].includes(brand)) return 'heic';
    if (['avif', 'avis'].includes(brand)) return 'avif';
  }

  return null;
}

function isImageKind(kind) {
  return IMAGE_KINDS.has(kind);
}

function isAllowedLogoKind(kind) {
  return LOGO_KINDS.has(kind);
}

function isAllowedReferenceKind(kind) {
  return REFERENCE_KINDS.has(kind);
}

module.exports = {
  IMAGE_KINDS,
  LOGO_KINDS,
  REFERENCE_KINDS,
  detectBufferKind,
  isImageKind,
  isAllowedLogoKind,
  isAllowedReferenceKind,
};
