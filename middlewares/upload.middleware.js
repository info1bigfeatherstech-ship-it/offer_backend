const multer = require('multer');
const path = require('path');
const fs = require('fs');  // ✅ ADD THIS - Required for file system operations
const {
  MAX_GIFT_FILE_BYTES,
  MAX_REFERENCE_PHOTOS,
  MAX_LOGOS,
  MAX_BUSINESS_CARDS,
  IMAGE_MIME_TYPES,
  LOGO_MIME_TYPES,
} = require('../utils/corporateGiftEnquiryValidation');

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Category banner + card uploads (admin / product_manager). */
const MAX_CATEGORY_IMAGE_BYTES = 20 * 1024 * 1024;
const RETURN_PROOF_MAX_BYTES = 60 * 1024 * 1024;

// ===============================
// IMAGE UPLOAD (for products)
// ===============================
const imageStorage = multer.memoryStorage();

const imageFileFilter = (req, file, cb) => {
  const allowedMimes = [
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/jpg',
    'image/svg',
    'image/svg+xml',
    'image/heic',
    'image/heif',
    'image/tiff',
    'image/bmp',
    'image/gif',
    'image/avif'
  ];

  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only JPG/JPEG/PNG/WEBP/SVG/HEIC/HEIF/TIFF/BMP/GIF/AVIF images are allowed'), false);
  }
};

const imageUpload = multer({
  storage: imageStorage,
  fileFilter: imageFileFilter,
  limits: { fileSize: MAX_IMAGE_BYTES }
});

const uploadProductImages = imageUpload.any();
const uploadSingleImage = imageUpload.single('image');

// ===============================
// CATEGORY IMAGES (banner + card, 20 MB each, compressed server-side)
// ===============================
const categoryImageUpload = multer({
  storage: imageStorage,
  fileFilter: imageFileFilter,
  limits: {
    fileSize: MAX_CATEGORY_IMAGE_BYTES,
    files: 2
  }
});

/** Multipart fields: `image` (banner), `cardImage` (Top Categories tile). */
const uploadCategoryImages = categoryImageUpload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'cardImage', maxCount: 1 }
]);

// ===============================
// CSV / EXCEL UPLOAD
// ===============================
const csvStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, '../uploads');
    
    // ✅ Create directory if it doesn't exist
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    // ✅ Sanitize filename - remove spaces and special characters
    const cleanName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    cb(null, Date.now() + '-' + cleanName);
  }
});

const csvFileFilter = (req, file, cb) => {
  const allowedMimes = [
    'text/csv',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ];

  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only CSV or Excel files are allowed'), false);
  }
};

const csvUpload = multer({
  storage: csvStorage,
  fileFilter: csvFileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }
});

const uploadCSVFile = csvUpload.single('csvFile');


// ===============================
// BULK UPLOAD (CSV + ZIP)
// ===============================
const uploadBulkNewProductFiles = multer({
  storage: csvStorage,
  fileFilter: (req, file, cb) => {
    if (
      file.mimetype === "application/zip" ||
      file.mimetype === "application/x-zip-compressed" ||
      file.mimetype === "text/csv" ||
      file.mimetype === "application/vnd.ms-excel"
    ) {
      cb(null, true);
    } else {
      cb(new Error("Only CSV and ZIP files allowed"), false);
    }
  }
}).fields([
  { name: "csvFile", maxCount: 1 },
  { name: "imagesZip", maxCount: 1 }
]);

// ===============================
// WHOLESALER PROOFS (PDF / IMAGE)
// ===============================
const proofStorage = multer.memoryStorage();

const proofFileFilter = (req, file, cb) => {
  const allowedMimes = [
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/jpg',
    'image/svg',
    'image/svg+xml',
    'image/heic',
    'image/heif',
    'image/tiff',
    'image/bmp',
    'image/gif',
    'image/avif'
  ];

  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only PDF and JPG/JPEG/PNG/WEBP/SVG/HEIC/HEIF/TIFF/BMP/GIF/AVIF files are allowed for proofs'), false);
  }
};

const proofUpload = multer({
  storage: proofStorage,
  fileFilter: proofFileFilter,
  limits: { fileSize: MAX_IMAGE_BYTES }
});

const uploadWholesalerProofs = proofUpload.fields([
  { name: 'idProof', maxCount: 1 },
  { name: 'idProofUpload', maxCount: 1 },
  { name: 'idProofFile', maxCount: 1 },
  { name: 'businessAddressProof', maxCount: 1 },
  { name: 'businessAddressProofUpload', maxCount: 1 },
  { name: 'businessAddressProofFile', maxCount: 1 }
]);

// ===============================
// RETURN REQUEST PROOFS (VIDEO + IMAGES)
// ===============================
const returnProofUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const allowed = [
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/jpg',
      'video/mp4',
      'video/quicktime',
      'video/x-matroska',
      'video/webm'
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
      return;
    }
    cb(new Error('Only JPG/JPEG/PNG/WEBP images and MP4/MOV/MKV/WEBM videos are allowed'), false);
  },
  limits: {
    files: 4,
    fileSize: RETURN_PROOF_MAX_BYTES
  }
});

const uploadReturnProofs = returnProofUpload.fields([
  { name: 'proofVideo', maxCount: 1 },
  { name: 'proofImages', maxCount: 3 }
]);

// ===============================
// PRODUCT REVIEW IMAGES
// ===============================
const reviewImageUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: imageFileFilter,
  limits: {
    files: 5,
    fileSize: MAX_IMAGE_BYTES
  }
});

const uploadReviewImages = reviewImageUpload.fields([
  { name: 'reviewImages', maxCount: 5 }
]);

// ===============================
// SHIPMOZO LABEL LOGO (admin, per storefront)
// ===============================
const labelLogoUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: imageFileFilter,
  limits: {
    files: 1,
    fileSize: 1024 * 1024
  }
});

const uploadLabelLogoFile = labelLogoUpload.single('logo');

// ===============================
// CORPORATE GIFT ENQUIRY (logos + reference photos)
// ===============================
const giftEnquiryFileFilter = (req, file, cb) => {
  const field = String(file.fieldname || '');
  const mime = String(file.mimetype || '').toLowerCase();
  const reject = (code, message) => {
    const err = new Error(message);
    err.statusCode = 400;
    err.code = code;
    err.field = field;
    cb(err);
  };

  if (field === 'referencePhotos') {
    if (IMAGE_MIME_TYPES.includes(mime)) {
      cb(null, true);
      return;
    }
    reject(
      'INVALID_FILE_TYPE',
      'Reference photos must be image files (JPG, JPEG, PNG, WEBP). PDF is not allowed.'
    );
    return;
  }

  if (field === 'logos') {
    if (LOGO_MIME_TYPES.includes(mime)) {
      cb(null, true);
      return;
    }
    reject(
      'INVALID_FILE_TYPE',
      'Logo files must be images (JPG, JPEG, PNG, WEBP) or PDF. CDR/AI are not accepted.'
    );
    return;
  }

  if (field === 'businessCard') {
    if (LOGO_MIME_TYPES.includes(mime)) {
      cb(null, true);
      return;
    }
    reject(
      'INVALID_FILE_TYPE',
      'Business card must be an image (JPG, JPEG, PNG, WEBP) or PDF.'
    );
    return;
  }

  reject(
    'TOO_MANY_FILES',
    `Unexpected file field "${field}". Use referencePhotos, logos, or businessCard.`
  );
};

const giftEnquiryUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: giftEnquiryFileFilter,
  limits: {
    files: MAX_REFERENCE_PHOTOS + MAX_LOGOS + MAX_BUSINESS_CARDS,
    fileSize: MAX_GIFT_FILE_BYTES,
  },
});

const giftEnquiryFields = giftEnquiryUpload.fields([
  { name: 'referencePhotos', maxCount: MAX_REFERENCE_PHOTOS },
  { name: 'logos', maxCount: MAX_LOGOS },
  { name: 'businessCard', maxCount: MAX_BUSINESS_CARDS },
]);

/**
 * Multer wrapper so gift-enquiry upload failures return stable API codes
 * instead of a generic 500 / MulterError.
 */
function uploadGiftEnquiryFiles(req, res, next) {
  giftEnquiryFields(req, res, (err) => {
    if (!err) return next();

    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        code: 'FILE_TOO_LARGE',
        message: 'Each file must be 20 MB or smaller.',
      });
    }
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({
        success: false,
        code: 'TOO_MANY_FILES',
        message:
          'Too many files. Reference photos: max 6 images. Logos: max 3. Business card: max 1.',
        field: err.field || undefined,
      });
    }
    if (err.statusCode && err.code) {
      return res.status(err.statusCode).json({
        success: false,
        code: err.code,
        message: err.message,
        ...(err.field ? { field: err.field } : {}),
      });
    }
    return res.status(400).json({
      success: false,
      code: 'INVALID_FILE_TYPE',
      message: err.message || 'Uploaded file is not allowed.',
    });
  });
}

module.exports = {
  uploadProductImages,
  uploadSingleImage,
  uploadCategoryImages,
  uploadCSVFile,
  uploadBulkNewProductFiles,
  uploadWholesalerProofs,
  uploadReturnProofs,
  uploadReviewImages,
  uploadLabelLogoFile,
  uploadGiftEnquiryFiles,
};