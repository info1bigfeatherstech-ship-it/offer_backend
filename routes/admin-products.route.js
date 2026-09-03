const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { verifyToken } = require('../middlewares/auth.middleware');
const { authorizeRoles } = require('../middlewares/authorize-roles.middleware');
const { uploadProductImages, uploadCSVFile, uploadBulkNewProductFiles } = require('../middlewares/upload.middleware');
const productController = require('../controllers/product.controller');
const updateProductTagController = require('../controllers/updateProductTag.controller');

const readRoles = authorizeRoles('admin', 'product_manager', 'inventory_manager');
const writeRoles = authorizeRoles('admin', 'product_manager');
const inventoryWriteRoles = authorizeRoles('admin', 'product_manager', 'inventory_manager');

// Validation middleware to check for rejected fields
const rejectSlugSku = (req, res, next) => {
  if ('slug' in req.body || 'sku' in req.body) {
    return res.status(400).json({ success: false, message: 'slug and sku are auto-generated; do not provide them' });
  }
  next();
};

router.use(verifyToken);

// =============================================
// PRODUCT CRUD - Write routes (catalog managers only)
// =============================================
router.post(
  '/',
  writeRoles,
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
// BULK UPLOAD & PREVIEW ROUTES (catalog managers only)
// =============================================
router.post('/preview-csv', writeRoles, uploadCSVFile, productController.previewBulkUpload);
router.post('/preview-import-csv', writeRoles, uploadCSVFile, productController.previewImportProductsFromCSV);
router.post('/import-csv', writeRoles, uploadCSVFile, productController.importProductsFromCSV);
router.get('/download-error-report/:fileName', writeRoles, productController.downloadErrorReport);
router.post('/bulk-new-products', writeRoles, uploadBulkNewProductFiles, productController.bulkUploadNewProductsWithImages);
router.patch('/bulk-status', writeRoles, productController.bulkUpdateProductStatus);
router.get('/bulk-upload-template', writeRoles, productController.downloadBulkUploadTemplate);

// =============================================
// LIST & FILTER ROUTES (read + inventory_manager)
// =============================================
router.get('/archived', writeRoles, productController.getArchivedProducts);
router.post('/bulk-delete', writeRoles, productController.bulkDelete);
router.patch('/bulk-restore', writeRoles, productController.bulkRestore);
router.get('/low-stock', readRoles, productController.getLowStockProducts);
router.get('/drafts', readRoles, productController.getDraftProducts);
router.get('/all', readRoles, productController.getAllProductsAdmin);
router.get('/export-csv', writeRoles, productController.exportProductsCSV);
router.delete('/bulk-hard-delete', writeRoles, productController.bulkHardDelete);
router.get('/active', readRoles, productController.getAllActiveProducts);

router.put('/updateFlags', writeRoles, updateProductTagController);

// =============================================
// SINGLE PRODUCT ACTIONS (with :slug, :productCode)
// =============================================
router.patch('/restore/:slug', writeRoles, productController.restoreProduct);
router.delete('/hard/:slug', writeRoles, productController.hardDeleteProduct);
router.post('/:slug/variants', writeRoles, uploadProductImages, productController.addVariant);
router.patch('/:slug/variants/:productCode/channel-visibility', writeRoles, productController.updateVariantChannelVisibility);
router.delete('/:slug/variants', writeRoles, productController.deleteVariant);
router.get('/variant/:productCode', readRoles, productController.getVariantByproductCode);

// Inventory-only patch — must be registered before PUT /:slug
router.patch('/:slug/inventory', inventoryWriteRoles, productController.patchProductInventory);

router.put('/:slug', writeRoles, uploadProductImages, rejectSlugSku, productController.updateProduct);
router.delete('/:slug', writeRoles, productController.deleteProduct);
router.get('/:slug', readRoles, productController.getProductBySlug);

module.exports = router;
