const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/auth.middleware');
const { authorizeRoles } = require('../middlewares/authorize-roles.middleware');
const { uploadCategoryImages } = require('../middlewares/upload.middleware');
const categoryController = require('../controllers/category.controller');

// Public category endpoints
router.get('/categories', categoryController.getAllCategories);
router.get('/admin/categories',  categoryController.getAdminAllCategories);
router.get('/categories/:id', categoryController.getCategoryById);

// Admin routes for reordering and visibility
router.post('/admin/categories/reorder', verifyToken, authorizeRoles('admin', 'product_manager'), categoryController.reorderCategories);
router.patch('/admin/categories/:id/toggle-visibility', verifyToken, authorizeRoles('admin', 'product_manager'), categoryController.toggleCategoryVisibility);
router.get('/admin/categories/all', verifyToken, authorizeRoles('admin', 'product_manager'), categoryController.getAllCategoriesAdmin);//rmeove it we dont need it 

// Admin category endpoints (banner `image` + Top Categories `cardImage`, max 20MB each)
router.post('/admin/categories', verifyToken, authorizeRoles('admin', 'product_manager'), uploadCategoryImages, categoryController.createCategory);
router.put('/admin/categories/:id', verifyToken, authorizeRoles('admin', 'product_manager'), uploadCategoryImages, categoryController.updateCategory);
router.delete('/admin/categories/:id', verifyToken, authorizeRoles('admin', 'product_manager'), categoryController.deleteCategory);

module.exports = router;
