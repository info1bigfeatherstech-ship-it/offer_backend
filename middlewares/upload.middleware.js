const multer = require('multer');
const path = require('path');
const fs = require('fs');  // ✅ ADD THIS - Required for file system operations

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
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


module.exports = {
  uploadProductImages,
  uploadSingleImage,
  uploadCSVFile,
  uploadBulkNewProductFiles,
  uploadWholesalerProofs,
  uploadReturnProofs,
  uploadReviewImages
};