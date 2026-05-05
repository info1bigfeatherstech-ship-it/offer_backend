// const express = require('express');
// const router = express.Router();
// const { body, validationResult } = require('express-validator');
// const { verifyToken } = require('../middlewares/auth.middleware');
// const { authorizeRoles } = require('../middlewares/authorize-roles.middleware');
// const { uploadProductImages, uploadCSVFile, uploadBulkNewProductFiles } = require('../middlewares/upload.middleware');
// const productController = require('../controllers/product.controller');

// // Validation middleware to check for rejected fields
// const rejectSlugSku = (req, res, next) => {
//   if ('slug' in req.body || 'sku' in req.body) {
//     return res.status(400).json({ success: false, message: 'slug and sku are auto-generated; do not provide them' });
//   }
//   next();
// };

// // POST /admin/products Create new product with optional image uploads
// // Request body (form-data): name, description, category, price, inventory, variants, status
// // Files: images (array of up to 10 image files)
// router.use(verifyToken);
// router.use(authorizeRoles('admin', 'product_manager'));

// router.post(
//   '/',
//   uploadProductImages,
//   rejectSlugSku,
//   [
//     body('name')
//       .trim()
//       .notEmpty()
//       .withMessage('Product name is required'),

//     body('description')
//       .trim()
//       .notEmpty()
//       .withMessage('Product description is required'),

//     body('category')
//       .notEmpty()
//       .withMessage('Product category is required'),

//     body('variants.*.price.base')
//       .notEmpty()
//       .withMessage('Variant base price is required')
//       .isNumeric()
//       .withMessage('Variant base price must be a number'),

//     body('status')
//       .optional()
//       .isIn(['draft', 'active', 'archived'])
//       .withMessage('Invalid status'),

//     body('isFeatured')
//       .optional()
//       .isBoolean()
//       .withMessage('isFeatured must be true or false')
//   ],
//   (req, res, next) => {
//     const errors = validationResult(req);

//     if (!errors.isEmpty()) {
//       return res.status(400).json({
//         success: false,
//         message: 'Validation failed',
//         errors: errors.array()
//       });
//     }

//     next();
//   },
//   productController.createProduct
// );

// // Bulk create (JSON body)
// // router.post('/bulk-create', productController.bulkCreateProducts);

// // Import from CSV
// router.post('/import-csv', uploadCSVFile, productController.importProductsFromCSV);


// // Download error report
// router.get('/download-error-report/:fileName', productController.downloadErrorReport);


// //import csv for new products with images
// router.post('/bulk-new-products', uploadBulkNewProductFiles, productController.bulkUploadNewProductsWithImages);

// // Get archived products
// router.get('/archived', productController.getArchivedProducts);

// // POST /admin/products/bulk-delete Bulk delete (archive)
// router.post('/bulk-delete', productController.bulkDelete);

// // Bulk restore
// router.patch('/bulk-restore', productController.bulkRestore);

// // GET /admin/products/low-stock Get low stock products
// router.get('/low-stock', productController.getLowStockProducts);

// // Get draft products
// router.get('/drafts', productController.getDraftProducts);

// //with limit and page query
// router.get('/all', productController.getAllProductsAdmin);

// // Bulk hard delete
// router.delete('/bulk-hard-delete', productController.bulkHardDelete);

// // Restore single
// router.patch('/restore/:slug', productController.restoreProduct);

// // Hard delete single (only archived)
// router.delete('/hard/:slug', productController.hardDeleteProduct);

// // Get all active products
// router.get('/active', productController.getAllActiveProducts);

// router.post('/preview-csv', uploadCSVFile, productController.previewBulkUpload);

// //post //add variant to product
// router.post('/:slug/variants', uploadProductImages, productController.addVariant);

// //delete variant from product
// router.delete('/:slug/variants', productController.deleteVariant);

// //get variant by productCode
// router.get('/variant/:productCode', productController.getVariantByproductCode);

// // PUT /admin/products/:slug Update product with optional image uploads
// router.put('/:slug', uploadProductImages, rejectSlugSku, productController.updateProduct);

// // DELETE /admin/products/:slug Soft delete (archive)
// router.delete('/:slug', productController.deleteProduct);

// //Get /admin/products/:slug get porduct by slug name 
// router.get('/:slug', productController.getProductBySlug);



// module.exports = router;


const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { verifyToken } = require('../middlewares/auth.middleware');
const { authorizeRoles } = require('../middlewares/authorize-roles.middleware');
const { uploadProductImages, uploadCSVFile, uploadBulkNewProductFiles } = require('../middlewares/upload.middleware');
const productController = require('../controllers/product.controller');
const updateProductTagController = require('../controllers/updateProductTag.controller');
// Validation middleware to check for rejected fields
const rejectSlugSku = (req, res, next) => {
  if ('slug' in req.body || 'sku' in req.body) {
    return res.status(400).json({ success: false, message: 'slug and sku are auto-generated; do not provide them' });
  }
  next();
};

router.use(verifyToken);
router.use(authorizeRoles('admin', 'product_manager'));

// =============================================
// PRODUCT CRUD - Main routes
// =============================================
router.post(
  '/',
  uploadProductImages,
  rejectSlugSku,
  [
    body('name').trim().notEmpty().withMessage('Product name is required'),
    body('description').trim().notEmpty().withMessage('Product description is required'),
    body('category').notEmpty().withMessage('Product category is required'),
    body('variants.*.price.base').notEmpty().withMessage('Variant base price is required').isNumeric().withMessage('Variant base price must be a number'),
    body('status').optional().isIn(['draft', 'active', 'archived']).withMessage('Invalid status'),
    body('isFeatured').optional().isBoolean().withMessage('isFeatured must be true or false')
  ],
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }
    next();
  },
  productController.createProduct
);

// =============================================
// BULK UPLOAD & PREVIEW ROUTES (Specific paths)
// =============================================
router.post('/preview-csv', uploadCSVFile, productController.previewBulkUpload);
router.post('/preview-import-csv', uploadCSVFile, productController.previewImportProductsFromCSV);
router.post('/import-csv', uploadCSVFile, productController.importProductsFromCSV);
router.get('/download-error-report/:fileName', productController.downloadErrorReport);
router.post('/bulk-new-products', uploadBulkNewProductFiles, productController.bulkUploadNewProductsWithImages);
router.patch('/bulk-status', productController.bulkUpdateProductStatus);

// =============================================
// LIST & FILTER ROUTES (Specific paths)
// =============================================
router.get('/archived', productController.getArchivedProducts);
router.post('/bulk-delete', productController.bulkDelete);
router.patch('/bulk-restore', productController.bulkRestore);
router.get('/low-stock', productController.getLowStockProducts);
router.get('/drafts', productController.getDraftProducts);
router.get('/all', productController.getAllProductsAdmin);
router.delete('/bulk-hard-delete', productController.bulkHardDelete);
router.get('/active', productController.getAllActiveProducts);
            
router.put("/updateFlags", updateProductTagController);
// =============================================
// SINGLE PRODUCT ACTIONS (with :slug, :productCode)
// =============================================
router.patch('/restore/:slug', productController.restoreProduct);
router.delete('/hard/:slug', productController.hardDeleteProduct);
router.post('/:slug/variants', uploadProductImages, productController.addVariant);
router.patch('/:slug/variants/:productCode/channel-visibility', productController.updateVariantChannelVisibility);
router.delete('/:slug/variants', productController.deleteVariant);
router.get('/variant/:productCode', productController.getVariantByproductCode);
router.put('/:slug', uploadProductImages, rejectSlugSku, productController.updateProduct);
router.delete('/:slug', productController.deleteProduct);
router.get('/:slug', productController.getProductBySlug);
// router.get('/', productController.getAllActiveProducts); // Get products with filters, pagination, search, etc.
module.exports = router;