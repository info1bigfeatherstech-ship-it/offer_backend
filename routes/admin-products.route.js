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