const multer = require('multer');
const path = require('path');
const fs = require('fs');  // ✅ ADD THIS - Required for file system operations

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
    'image/svg'
  ];

  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only jpeg, jpg, png, webp, svg images are allowed'), false);
  }
};

const imageUpload = multer({
  storage: imageStorage,
  fileFilter: imageFileFilter,
  limits: { fileSize: 50 * 1024 * 1024 }
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
    'image/jpg'
  ];

  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only PDF, JPG, JPEG, PNG, WEBP files are allowed for proofs'), false);
  }
};

const proofUpload = multer({
  storage: proofStorage,
  fileFilter: proofFileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }
});

const uploadWholesalerProofs = proofUpload.fields([
  { name: 'idProof', maxCount: 1 },
  { name: 'idProofUpload', maxCount: 1 },
  { name: 'idProofFile', maxCount: 1 },
  { name: 'businessAddressProof', maxCount: 1 },
  { name: 'businessAddressProofUpload', maxCount: 1 },
  { name: 'businessAddressProofFile', maxCount: 1 }
]);


module.exports = {
  uploadProductImages,
  uploadSingleImage,
  uploadCSVFile,
  uploadBulkNewProductFiles,
  uploadWholesalerProofs
};