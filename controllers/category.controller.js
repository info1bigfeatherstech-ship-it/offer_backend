const Category = require('../models/Category');
const Product = require('../models/Product');
const slugify = require('slugify');
const {
  uploadToCloudinary,
  deleteFromCloudinary,
  optimizeProductImageBuffer
} = require('../utils/cloudinaryHelper');

//  ADD THESE 2 LINES AT THE TOP
const cacheService = require('../services/cache.service');
const cacheConfig = require('../config/cache.config');
const { setApiCacheHeaders } = require('../utils/apiCacheHeaders');

/** Category tiles / headers: slightly tighter cap than product gallery (override via env). */
const CATEGORY_IMAGE_MAX_WIDTH = Math.min(
  2048,
  Math.max(400, Number(process.env.CATEGORY_IMAGE_MAX_WIDTH) || 1200)
);

function getCategoryImageOptimizeOptions() {
  const opts = { maxWidth: CATEGORY_IMAGE_MAX_WIDTH };
  const q = process.env.CATEGORY_IMAGE_WEBP_QUALITY;
  if (q !== undefined && q !== '' && !Number.isNaN(Number(q))) {
    opts.quality = Math.min(100, Math.max(50, Number(q)));
  }
  return opts;
}

/**
 * EXIF-safe resize, WebP encode, upload to Cloudinary `categories` folder with a stable public_id.
 * @param {Buffer} buffer — multer memory buffer
 * @param {{ nameHint: string, uniqueSuffix: string }} meta
 */
async function processAndUploadCategoryImage(buffer, { nameHint, uniqueSuffix }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('Invalid or empty image buffer');
  }
  const optimized = await optimizeProductImageBuffer(buffer, getCategoryImageOptimizeOptions());
  const base = slugify(String(nameHint || 'category'), { lower: true, strict: true }).slice(0, 72);
  const suffix = String(uniqueSuffix || Date.now()).replace(/[^a-zA-Z0-9_-]/g, '');
  const publicId = `${base}-${suffix}`.slice(0, 120);
  return uploadToCloudinary(optimized, 'categories', publicId);
}


// =============================================
// GET /categories - WITH CACHE
// =============================================
const getAllCategories = async (req, res) => {
  try {
    // Categories are shared across storefronts; keep one cache key for all panels.
    const cacheKey = cacheConfig.generateKey('CATEGORY', { all: true });

    //  CHECK CACHE FIRST
    const cachedData = await cacheService.get(cacheKey);
    if (cachedData) {
      res.setHeader('X-Cache', 'HIT');
      setApiCacheHeaders(res);
      return res.status(200).json(cachedData);
    }

    let categories = await Category.find({ status: 'active' })
      .sort({ order: 1, name: 1 })
      .lean();

    const map = new Map();
    categories.forEach(cat => {
      cat.children = [];
      map.set(String(cat._id), cat);
    });

    const roots = [];
    categories.forEach(cat => {
      if (cat.parent) {
        const parent = map.get(String(cat.parent));
        if (parent) parent.children.push(cat);
        else roots.push(cat);
      } else {
        roots.push(cat);
      }
    });

    const responseData = {
      success: true,
      count: categories.length,
      categories: roots
    };

    //  STORE IN CACHE (30 minutes)
    await cacheService.set(cacheKey, responseData, cacheConfig.ttl.CATEGORY_LIST);

    res.setHeader('X-Cache', 'MISS');
    setApiCacheHeaders(res);
    return res.status(200).json(responseData);

  } catch (error) {
    console.error('Get categories error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error fetching categories',
      error: error.message
    });
  }
};


// =============================================
// GET /categories/:id - WITH CACHE
// =============================================
const getCategoryById = async (req, res) => {
  try {
    const { id } = req.params;
    // Categories are shared across storefronts; keep one cache key for all panels.
    const cacheKey = cacheConfig.generateKey('CATEGORY', { id });

    //  CHECK CACHE FIRST
    const cachedData = await cacheService.get(cacheKey);
    if (cachedData) {
      res.setHeader('X-Cache', 'HIT');
      setApiCacheHeaders(res);
      return res.status(200).json(cachedData);
    }

    const category = await Category.findOne({
      _id: id,
      status: 'active'
    }).lean();

    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    const responseData = {
      success: true,
      category
    };

    //  STORE IN CACHE
    await cacheService.set(cacheKey, responseData, cacheConfig.ttl.CATEGORY_DETAIL);

    res.setHeader('X-Cache', 'MISS');
    setApiCacheHeaders(res);
    return res.status(200).json(responseData);

  } catch (error) {
    console.error('Get category error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error fetching category',
      error: error.message
    });
  }
};

// =============================================
// REST ALL FUNCTIONS SAME AS BEFORE (NO CHANGE)
// =============================================

const createCategory = async (req, res) => {
  try {
    const {
      name,
      description,
      parent,
      order,
      status,
      showInMenu
    } = req.body;

    if (!name) { 
      return res.status(400).json({
        success: false,
        message: 'Category name is required'
      });
    }

    if (parent) {
      const parentExists = await Category.findById(parent);
      if (!parentExists || parentExists.status !== 'active') {
        return res.status(400).json({
          success: false,
          message: 'Invalid or inactive parent category'
        });
      }
    }
    
    const existingCategory = await Category.findOne({
      name: { $regex: new RegExp(`^${name}$`, 'i') },
      parent: parent || null
    });
    
    if (existingCategory) {
      return res.status(400).json({
        success: false,
        message: 'Category with the same name already exists under the same parent'
      });
    }

    const category = new Category({
      name,
      description: description || '',
      parent: parent || null,
      order: order || 0,
      status: status !== undefined ? status : 'active',
      showInMenu: showInMenu !== undefined ? showInMenu : true
    });

    if (parent) {
      const p = await Category.findById(parent);
      category.level = p ? (p.level || 0) + 1 : 0;
    } else {
      category.level = 0;
    }

    if (req.file && req.file.buffer) {
      try {
        const { url, publicId } = await processAndUploadCategoryImage(req.file.buffer, {
          nameHint: name,
          uniqueSuffix: `${Date.now()}`
        });
        category.image = { url, publicId };
      } catch (err) {
        console.error('Category image upload failed:', err.message);
        return res.status(400).json({
          success: false,
          message: 'Category image could not be processed or uploaded',
          error: err.message
        });
      }
    }

    await category.save();

    //  INVALIDATE CATEGORY CACHE AFTER CREATE
    await cacheService.forget(`${cacheConfig.prefixes.CATEGORY}:*`);

    return res.status(201).json({
      success: true,
      message: 'Category created successfully',
      category
    });

  } catch (error) {
    console.error('Create category error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error creating category',
      error: error.message
    });
  }
};

const updateCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, parent, order, status } = req.body;

    const category = await Category.findById(id);
    if (!category) return res.status(404).json({ success: false, message: 'Category not found' });

    if (name) category.name = name;
    if (description !== undefined) category.description = description;
    if (order !== undefined) category.order = order;
    if (status) category.status = status;

    if (parent) {
      const p = await Category.findById(parent);
      category.parent = p ? p._id : null;
      category.level = p ? (p.level || 0) + 1 : 0;
    } else if (parent === null || parent === 'null') {
      category.parent = null;
      category.level = 0;
    }

    if (req.file && req.file.buffer) {
      try {
        const displayName = name || category.name;
        const { url, publicId } = await processAndUploadCategoryImage(req.file.buffer, {
          nameHint: displayName,
          uniqueSuffix: `${String(id)}-${Date.now()}`
        });
        const previousPublicId = category.image?.publicId;
        category.image = { url, publicId };
        if (previousPublicId && previousPublicId !== publicId) {
          await deleteFromCloudinary(previousPublicId);
        }
      } catch (err) {
        console.error('Category image upload failed:', err.message);
        return res.status(400).json({
          success: false,
          message: 'Category image could not be processed or uploaded',
          error: err.message
        });
      }
    }

    await category.save();

    //  INVALIDATE CATEGORY CACHE AFTER UPDATE
    await cacheService.forget(`${cacheConfig.prefixes.CATEGORY}:*`);

    return res.status(200).json({ success: true, message: 'Category updated', category });
  } catch (error) {
    console.error('Update category error:', error);
    return res.status(500).json({ success: false, message: 'Error updating category', error: error.message });
  }
};

const deleteCategory = async (req, res) => {
  try {
    const { id } = req.params;

    const category = await Category.findById(id);
    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    if (category.status !== 'active') {
      return res.status(400).json({
        success: false,
        message: 'Category is already inactive'
      });
    }

    const childCategories = await Category.countDocuments({
      parent: id,
      status: 'active'
    });

    if (childCategories > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete category. ${childCategories} active subcategory(s) exist.`
      });
    }

    const productCount = await Product.countDocuments({
      category: id
    });

    if (productCount > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete category. ${productCount} product(s) are using this category.`
      });
    }

    const previousPublicId = category.image?.publicId;
    category.status = 'inactive';
    category.showInMenu = false;
    category.image = { url: '', publicId: '' };
    await category.save();

    if (previousPublicId) {
      try {
        await deleteFromCloudinary(previousPublicId);
      } catch (mediaErr) {
        // Non-fatal cleanup error: category state change should still succeed.
        console.error('Category media cleanup failed:', mediaErr.message);
      }
    }

    //  INVALIDATE CATEGORY CACHE AFTER DELETE
    await cacheService.forget(`${cacheConfig.prefixes.CATEGORY}:*`);

    return res.status(200).json({
      success: true,
      message: 'Category archived successfully',
      category
    });

  } catch (error) {
    console.error('Delete category error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error deleting category',
      error: error.message
    });
  }
};

const reorderCategories = async (req, res) => {
  try {
    const { categories } = req.body;
    
    if (!categories || !Array.isArray(categories)) {
      return res.status(400).json({
        success: false,
        message: "Invalid request. Expected { categories: [{ id, order }] }"
      });
    }

    const bulkOps = categories.map(cat => ({
      updateOne: {
        filter: { _id: cat.id },
        update: { order: cat.order }
      }
    }));

    await Category.bulkWrite(bulkOps);

    //  INVALIDATE CATEGORY CACHE AFTER REORDER
    await cacheService.forget(`${cacheConfig.prefixes.CATEGORY}:*`);

    const updatedCategories = await Category.find()
      .sort({ order: 1, name: 1 })
      .lean();

    return res.status(200).json({
      success: true,
      message: "Categories reordered successfully",
      categories: updatedCategories
    });
  } catch (error) {
    console.error('Reorder categories error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error reordering categories',
      error: error.message
    });
  }
};

const toggleCategoryVisibility = async (req, res) => {
  try {
    const { id } = req.params;
    const { isHidden } = req.body;

    const category = await Category.findById(id);
    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    category.status = isHidden ? 'inactive' : 'active';
    await category.save();

    //  INVALIDATE CATEGORY CACHE AFTER TOGGLE
    await cacheService.forget(`${cacheConfig.prefixes.CATEGORY}:*`);

    return res.status(200).json({
      success: true,
      message: `Category ${isHidden ? 'hidden' : 'shown'} successfully`,
      category
    });
  } catch (error) {
    console.error('Toggle category visibility error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error toggling category visibility',
      error: error.message
    });
  }
};

const getAllCategoriesAdmin = async (req, res) => {
  try {
    const categories = await Category.find()
      .sort({ order: 1, name: 1 })
      .lean();

    const map = new Map();
    categories.forEach(cat => {
      cat.children = [];
      cat.isHidden = cat.status === 'inactive';
      map.set(String(cat._id), cat);
    });

    const roots = [];
    categories.forEach(cat => {
      if (cat.parent) {
        const parent = map.get(String(cat.parent));
        if (parent) parent.children.push(cat);
        else roots.push(cat);
      } else {
        roots.push(cat);
      }
    });

    return res.status(200).json({
      success: true,
      count: categories.length,
      categories: roots
    });
  } catch (error) {
    console.error('Get all categories admin error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error fetching categories',
      error: error.message
    });
  }
};

module.exports = {
  getAllCategories,
  getCategoryById,
  createCategory,
  updateCategory,
  deleteCategory,
  reorderCategories,
  toggleCategoryVisibility,
  getAllCategoriesAdmin
};