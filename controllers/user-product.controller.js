// controllers/user-product.controller.js
const Product = require('../models/Product');
const Category = require('../models/Category');
const ProductTag = require('../models/ProductTag');
const cacheService = require('../services/cache.service');
const cacheConfig = require('../config/cache.config');
const { setApiCacheHeaders } = require('../utils/apiCacheHeaders');
const {
  mongoCatalogAnd,
  filterVariantsForStorefront,
  isProductListedOnStorefront,
  getVariantAvailability
} = require('../utils/storefrontCatalog');

const storefrontFrom = (req) => req.storefront || 'ecomm';
const useWholesalePricing = (storefront) => storefront === 'wholesale';

// Price resolution is storefront-driven:
// wholesale storefront => wholesale price for all visitors (logged-in or guest)
// ecomm storefront => retail price
const getVariantPrice = (variant, storefront) => {
  if (useWholesalePricing(storefront)) {
    const wholesaleBase = Number(variant.price?.wholesaleBase || 0);
    const wholesaleSaleRaw = variant.price?.wholesaleSale;
    const wholesaleSale = wholesaleSaleRaw != null ? Number(wholesaleSaleRaw) : null;
    const isSaleActive = Number.isFinite(wholesaleSale) && wholesaleSale > 0 && wholesaleSale < wholesaleBase;
    const current = isSaleActive ? wholesaleSale : wholesaleBase;
    const discountPercentage = isSaleActive && wholesaleBase > 0
      ? Math.round(((wholesaleBase - wholesaleSale) / wholesaleBase) * 100)
      : 0;
    return {
      base: wholesaleBase,
      sale: Number.isFinite(wholesaleSale) ? wholesaleSale : null,
      current,
      isSaleActive,
      discountPercentage,
      minimumOrderQuantity: variant.minimumOrderQuantity || 1
    };
  }
  const retailSaleRaw = variant.price?.sale;
  const retailSale = retailSaleRaw != null ? Number(retailSaleRaw) : null;
  const retailBase = Number(variant.price?.base || 0);
  const isSaleActive = Number.isFinite(retailSale) && retailSale > 0 && retailSale < retailBase;
  const current = isSaleActive ? retailSale : retailBase;
  const discountPercentage = isSaleActive && retailBase > 0
    ? Math.round(((retailBase - retailSale) / retailBase) * 100)
    : 0;
  return {
    base: retailBase,
    sale: Number.isFinite(retailSale) ? retailSale : null,
    current,
    isSaleActive,
    discountPercentage,
    minimumOrderQuantity: 1
  };
};

function mapProductVariantsForApi(product, userType, storefront) {
  const visible = filterVariantsForStorefront(product.variants || [], storefront);
  return visible.map((variant) => {
    const resolvedPrice = getVariantPrice(variant, storefront);
    const availability = getVariantAvailability(variant, storefront);
    return {
      ...variant,
      price: resolvedPrice,
      availability,
      // Keep top-level computed fields aligned with resolved storefront/user pricing.
      isSaleActive: Boolean(resolvedPrice.isSaleActive),
      finalPrice: Number(resolvedPrice.current || 0),
      discountPercentage: Number(resolvedPrice.discountPercentage || 0)
    };
  });
}

function decorateProductForStorefront(product, userType, storefront) {
  const variants = mapProductVariantsForApi(product, userType, storefront);
  const currentPrices = variants.map((v) => {
    const sale = Number(v?.price?.sale);
    const base = Number(v?.price?.base || 0);
    return Number.isFinite(sale) && sale > 0 && sale < base ? sale : base;
  });
  const minPrice = currentPrices.length ? Math.min(...currentPrices) : null;
  const maxPrice = currentPrices.length ? Math.max(...currentPrices) : null;
  const maxDiscountPercentage = variants.length
    ? Math.max(
      ...variants.map((v) => {
        const sale = Number(v?.price?.sale);
        const base = Number(v?.price?.base || 0);
        if (!(Number.isFinite(sale) && sale > 0 && sale < base && base > 0)) return 0;
        return Math.round(((base - sale) / base) * 100);
      })
    )
    : 0;

  return {
    ...product,
    variants,
    minPrice,
    maxPrice,
    maxDiscountPercentage
  };
}

// Attach `appliedTags: string[]` to every product in a list using a single
// batched ProductTag lookup. Products with no ProductTag document receive
// `appliedTags: []`. Multiple ProductTag rows per product (shouldn't happen
// per schema, but defensive) are merged and de-duplicated.
async function attachAppliedTagsToProducts(products) {
  if (!Array.isArray(products) || products.length === 0) {
    return Array.isArray(products) ? products : [];
  }

  const productIds = products.map((p) => p?._id).filter(Boolean);
  if (productIds.length === 0) {
    return products.map((p) => ({ ...p, appliedTags: [] }));
  }

  const tagDocs = await ProductTag.find({ product: { $in: productIds } })
    .select('product tags')
    .lean();

  const tagMap = new Map();
  for (const doc of tagDocs) {
    if (!doc?.product) continue;
    const key = String(doc.product);
    const incoming = Array.isArray(doc.tags) ? doc.tags : [];
    const existing = tagMap.get(key) || [];
    tagMap.set(key, Array.from(new Set([...existing, ...incoming])));
  }

  return products.map((p) => ({
    ...p,
    appliedTags: (p?._id && tagMap.get(String(p._id))) || [],
  }));
}

// Single-product variant of `attachAppliedTagsToProducts`. Always returns an
// `appliedTags` array on the decorated product object.
async function attachAppliedTagsToProduct(product) {
  if (!product || !product._id) {
    return product;
  }
  const doc = await ProductTag.findOne({ product: product._id })
    .select('tags')
    .lean();
  return {
    ...product,
    appliedTags: Array.isArray(doc?.tags) ? doc.tags : [],
  };
}

// =============================================
// GET /products/all - WITH CACHE
// =============================================

const getProducts = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || 12);
    const skip = (page - 1) * limit;
    const allProducts = await Product.find({}).lean();

console.table(
  allProducts.map((p) => ({
    name: p.name,
    sale: p.variants?.[0]?.price?.sale,
    base: p.variants?.[0]?.price?.base,
  }))
);
    // ✅ normalize tag (on_sale → on-sale)
    const normalizeTag = (tag) => tag.replace(/_/g, '-');

    const tagsRaw = req.query.tags;
    const tagsFilter = tagsRaw
      ? String(tagsRaw)
          .split(',')
          .map(t => normalizeTag(t.trim()))
          .filter(Boolean)
      : [];


    // ✅ category filter
    const storefront = storefrontFrom(req);
    const currentUserType = req.userType || "user";
      // category filter
    if (req.query.category) {
      const categoryDoc = await Category.findOne({
        slug: String(req.query.category).toLowerCase(),
      }).select("_id");

      if (categoryDoc) {
        extraClauses.push({ category: categoryDoc._id });
      }
    }

    // featured filter
    if (req.query.featured === "true") {
      extraClauses.push({ isFeatured: true });
    }
    const extraClauses = [];
    if (req.query.category) {
      const cat = await Category.findOne({
        slug: String(req.query.category).toLowerCase()
      }).select('_id');
      if (cat) extraClauses.push({ category: cat._id });
    }
    if (req.query.featured === 'true') extraClauses.push({ isFeatured: true });

    // tag filter
    if (tagsFilter.length > 0) {
      const taggedProducts = await ProductTag.find({
        tags: { $in: tagsFilter },
      })
        .select("product")
        .lean({ virtuals: true });

      const taggedProductIds = taggedProducts.map((item) => item.product);

      if (!taggedProductIds.length) {
        return res.json({
          success: true,
          pagination: {
            total: 0,
            page,
            limit,
            totalPages: 0,
            hasNextPage: false,
            hasPrevPage: false,
          },
          products: [],
          appliedTags: tagsFilter,
        });
      }

      extraClauses.push({
        _id: { $in: taggedProductIds },
      });
    }

    // search
    let sortOption = { createdAt: -1 };

    if (req.query.q) {
      extraClauses.push({
        $text: { $search: String(req.query.q) },
      });

      sortOption = {
        score: { $meta: "textScore" },
      };
    }

    const filters = mongoCatalogAnd(storefront, ...extraClauses);

    const cacheKey = cacheConfig.generateKey("PRODUCT", {
      page,
      limit,
      category: req.query.category,
      featured: req.query.featured,
      q: req.query.q,
      tags: tagsFilter.join(","),
      userType: currentUserType,
      storefront,
    });

    const bypassCache = req.query._cb === "1";

    const cachedData = bypassCache
      ? null
      : await cacheService.get(cacheKey);

    if (cachedData) {
      res.setHeader("X-Cache", "HIT");
      setApiCacheHeaders(res);
      return res.json(cachedData);
    }

    const projection = req.query.q
      ? { score: { $meta: 'textScore' } }
      : undefined;

    const [total, products] = await Promise.all([
      Product.countDocuments(filters),
      Product.find(filters, projection)
        .sort(sortOption)
        .skip(skip)
        .limit(limit)
        .populate("category")
        .lean({ virtuals: true }),
    ]);

    const productsWithData = await attachAppliedTagsToProducts(
      products.map((product) =>
        decorateProductForStorefront(
          product,
          currentUserType,
          storefront
        )
      )
    );

    return res.json({
      success: true,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page * limit < total,
        hasPrevPage: page > 1,
      },
      products: productsWithData,
      userType: currentUserType,
      storefront,
      appliedTags: tagsFilter,
    });

    await cacheService.set(
      cacheKey,
      responseData,
      cacheConfig.ttl.PRODUCT_LIST
    );

    res.setHeader("X-Cache", "MISS");
    setApiCacheHeaders(res);

    return res.json(responseData);
  } catch (err) {
    console.error("getProducts:", err);

    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

// =============================================
// GET /products/:slug - WITH CACHE
// =============================================
const getProductBySlug = async (req, res) => {
  try {
    const { slug } = req.params;
    const userType = req.userType || 'user';
    const storefront = storefrontFrom(req);

    const cacheKey = cacheConfig.generateKey('PRODUCT', { slug, userType, storefront });

    //  CHECK CACHE FIRST
    const cachedData = await cacheService.get(cacheKey);
    if (cachedData) {
      res.setHeader('X-Cache', 'HIT');
      setApiCacheHeaders(res);
      return res.json(cachedData);
    }
    
    const product = await Product.findOne(
      mongoCatalogAnd(storefront, { slug: String(slug).toLowerCase() })
    ).populate('category');

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    const productResponse = await attachAppliedTagsToProduct(
      decorateProductForStorefront(
        product.toObject(),
        userType,
        storefront
      )
    );

    const responseData = {
      success: true,
      product: productResponse,
      userType,
      storefront
    };

    //  STORE IN CACHE
    await cacheService.set(cacheKey, responseData, cacheConfig.ttl.PRODUCT_DETAIL);

    res.setHeader('X-Cache', 'MISS');
    setApiCacheHeaders(res);
    return res.json(responseData);

  } catch (err) {
    console.error('getProductBySlug:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};



// search working with title name and product code working

const searchProducts = async (req, res) => {
  try {
    const q = req.query.q || "";

    if (!q) {
      return res.status(400).json({
        success: false,
        message: "Query required",
      });
    }

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || 12);
    const skip = (page - 1) * limit;

    // ✅ ADD THIS

    //  GENERATE CACHE KEY
    const currentUserType = req.userType || "user";
    const currentStorefront = storefrontFrom(req);

    // tags
    const normalizeTag = (tag) => tag.replace(/_/g, "-");

    const tagsRaw = req.query.tags;
    const tagsFilter = tagsRaw
      ? String(tagsRaw)
          .split(",")
          .map((t) => normalizeTag(t.trim()))
          .filter(Boolean)
      : [];

    const cacheKey = cacheConfig.generateKey("SEARCH", {
      q,
      page,
      limit,
      tags: tagsFilter.join(","),
      userType: currentUserType,
      storefront: currentStorefront,
    });

    const bypassCache = req.query._cb === "1";

    const cachedData = bypassCache
      ? null
      : await cacheService.get(cacheKey);

    if (cachedData) {
      res.setHeader("X-Cache", "HIT");
      setApiCacheHeaders(res);
      return res.json(cachedData);
    }

    // Build search filter for name, title, and variants.productCode only
    const searchRegex = { $regex: q, $options: "i" };
    const extraClauses = [
      {
        $or: [
          { name: searchRegex },
          { title: searchRegex },
          { "variants.productCode": searchRegex }
        ]
      }
    ];

    // tag filter
    if (tagsFilter.length > 0) {
      const taggedProducts = await ProductTag.find({
        tags: { $in: tagsFilter },
      })
        .select("product")
        .lean();

      const taggedProductIds = taggedProducts.map(
        (item) => item.product
      );

      if (!taggedProductIds.length) {
        return res.json({
          success: true,
          total: 0,
          page,
          limit,
          products: [],
          userType: currentUserType,
          storefront: currentStorefront,
          appliedTags: tagsFilter,
        });
      }

      extraClauses.push({
        _id: { $in: taggedProductIds },
      });
    }

    const filters = mongoCatalogAnd(
      currentStorefront,
      ...extraClauses
    );

    const total = await Product.countDocuments(filters);

    const products = await Product.find(filters)
      .skip(skip)
      .limit(limit)
      .populate("category")
      .lean({ virtuals: true });

    const productsWithData = await attachAppliedTagsToProducts(
      products.map((product) =>
        decorateProductForStorefront(
          product,
          currentUserType,
          currentStorefront
        )
      )
    );

    const responseData = {
      success: true,
      total,
      page,
      limit,
      products: productsWithData,
      userType: currentUserType,
      storefront: currentStorefront,
      appliedTags: tagsFilter,
    };

    await cacheService.set(
      cacheKey,
      responseData,
      cacheConfig.ttl.PRODUCT_SEARCH
    );

    res.setHeader("X-Cache", "MISS");
    setApiCacheHeaders(res);

    return res.json(responseData);
  } catch (err) {
    console.error("searchProducts:", err);

    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};





// =============================================
// GET /products/search - WITH CACHE
// =============================================
const searchProducts= async (req, res) => {
  try {
    console.log("with base code")
    const q = String(req.query.q || "").trim();

    if (!q) {
      return res.status(400).json({
        success: false,
        message: "Query required",
      });
    }

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || 12);
    const skip = (page - 1) * limit;

    // ✅ ADD THIS

    //  GENERATE CACHE KEY
    const currentUserType = req.userType || "user";
    const currentStorefront = storefrontFrom(req);

    // tags
    const normalizeTag = (tag) => tag.replace(/_/g, "-");

    const tagsRaw = req.query.tags;
    const tagsFilter = tagsRaw
      ? String(tagsRaw)
          .split(",")
          .map((t) => normalizeTag(t.trim()))
          .filter(Boolean)
      : [];

    const cacheKey = cacheConfig.generateKey("SEARCH", {
      v: "code-prefix-v2",
      q,
      page,
      limit,
      tags: tagsFilter.join(","),
      userType: currentUserType,
      storefront: currentStorefront,
    });

    const bypassCache = req.query._cb === "1";

    const cachedData = bypassCache
      ? null
      : await cacheService.get(cacheKey);

    if (cachedData) {
      res.setHeader("X-Cache", "HIT");
      setApiCacheHeaders(res);
      return res.json(cachedData);
    }

    // Build search filter.
    // If query looks like a product code (e.g. 0053 / 0053-1), prefer productCode-family match.
    const escapeRegex = (value) =>
      String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedQ = escapeRegex(q);
    const searchRegex = { $regex: escapedQ, $options: "i" };
    const baseCode = q.split("-")[0].trim();
    const escapedBaseCode = escapeRegex(baseCode);
    const productCodePrefixRegex = {
      $regex: `^${escapedBaseCode}(?:-|$)`,
      $options: "i",
    };
    const looksLikeProductCode = /^[a-z0-9-]+$/i.test(q) && /\d/.test(q);

    const searchOrClauses = looksLikeProductCode
      ? [{ "variants.productCode": productCodePrefixRegex }]
      : [
          { name: searchRegex },
          { title: searchRegex },
          { "variants.productCode": searchRegex },
          { "variants.productCode": productCodePrefixRegex },
        ];

    const extraClauses = [
      {
        $or: searchOrClauses,
      },
    ];

    // tag filter
    if (tagsFilter.length > 0) {
      const taggedProducts = await ProductTag.find({
        tags: { $in: tagsFilter },
      })
        .select("product")
        .lean();

      const taggedProductIds = taggedProducts.map(
        (item) => item.product
      );

      if (!taggedProductIds.length) {
        return res.json({
          success: true,
          total: 0,
          page,
          limit,
          products: [],
          userType: currentUserType,
          storefront: currentStorefront,
          appliedTags: tagsFilter,
        });
      }

      extraClauses.push({
        _id: { $in: taggedProductIds },
      });
    }

    const filters = mongoCatalogAnd(
      currentStorefront,
      ...extraClauses
    );

    const total = await Product.countDocuments(filters);

    const products = await Product.find(filters)
      .skip(skip)
      .limit(limit)
      .populate("category")
      .lean({ virtuals: true });

    const productsWithData = await attachAppliedTagsToProducts(
      products.map((product) =>
        decorateProductForStorefront(
          product,
          currentUserType,
          currentStorefront
        )
      )
    );

    const responseData = {
      success: true,
      total,
      page,
      limit,
      products: productsWithData,
      userType: currentUserType,
      storefront: currentStorefront,
      appliedTags: tagsFilter,
    };

    await cacheService.set(
      cacheKey,
      responseData,
      cacheConfig.ttl.PRODUCT_SEARCH
    );

    res.setHeader("X-Cache", "MISS");
    setApiCacheHeaders(res);

    return res.json(responseData);
  } catch (err) {
    console.error("searchProducts:", err);

    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

const getProductsByCategory = async (req, res) => {
  try {
    const { slug } = req.params;

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || 12);
    const skip = (page - 1) * limit;

    const currentUserType = req.userType || "user";
    const currentStorefront = storefrontFrom(req);

    // tags
    const normalizeTag = (tag) => tag.replace(/_/g, "-");

    const tagsRaw = req.query.tags;
    const tagsFilter = tagsRaw
      ? String(tagsRaw)
          .split(",")
          .map((t) => normalizeTag(t.trim()))
          .filter(Boolean)
      : [];

    const cacheKey = cacheConfig.generateKey("PRODUCT", {
      categorySlug: slug,
      page,
      limit,
      tags: tagsFilter.join(","),
      userType: currentUserType,
      storefront: currentStorefront,
    });

    const bypassCache = req.query._cb === "1";

    const cachedData = bypassCache
      ? null
      : await cacheService.get(cacheKey);

    if (cachedData) {
      res.setHeader("X-Cache", "HIT");
      setApiCacheHeaders(res);
      return res.json(cachedData);
    }

    const category = await Category.findOne({
      slug: String(slug).toLowerCase(),
    });

    if (!category) {
      return res.status(404).json({
        success: false,
        message: "Category not found",
      });
    }

    const extraClauses = [
      { category: category._id },
    ];

    // tag filter
    if (tagsFilter.length > 0) {
      const taggedProducts = await ProductTag.find({
        tags: { $in: tagsFilter },
      })
        .select("product")
        .lean();

      const taggedProductIds = taggedProducts.map(
        (item) => item.product
      );

      if (!taggedProductIds.length) {
        return res.json({
          success: true,
          total: 0,
          page,
          limit,
          products: [],
          category,
          userType: currentUserType,
          storefront: currentStorefront,
          appliedTags: tagsFilter,
        });
      }

      extraClauses.push({
        _id: { $in: taggedProductIds },
      });
    }

    const filters = mongoCatalogAnd(
      currentStorefront,
      ...extraClauses
    );

    // ✅ ADD THIS — tags filter using ProductTag lookup
    if (tagsFilter.length > 0) {
      const taggedProducts = await ProductTag.find({
        tags: { $in: tagsFilter }
      }).select('product').lean();

      const taggedProductIds = taggedProducts.map(t => t.product);
      filters._id = { $in: taggedProductIds };
    }

    const total = await Product.countDocuments(filters);

    const products = await Product.find(filters)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("category")
      .lean({ virtuals: true });

    const productsWithData = await attachAppliedTagsToProducts(
      products.map((product) =>
        decorateProductForStorefront(
          product,
          currentUserType,
          currentStorefront
        )
      )
    );

    const responseData = {
      success: true,
      total,
      page,
      limit,
      products: productsWithData,
      category,
      userType: currentUserType,
      storefront: currentStorefront,
      appliedTags: tagsFilter,
    };

    await cacheService.set(
      cacheKey,
      responseData,
      cacheConfig.ttl.PRODUCT_CATEGORY
    );

    res.setHeader("X-Cache", "MISS");
    setApiCacheHeaders(res);

    return res.json(responseData);
  } catch (err) {
    console.error("getProductsByCategory:", err);

    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};   

const getFeaturedProducts = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || 12);
    const skip = (page - 1) * limit;
    const userType = req.userType || 'user';
    const storefront = storefrontFrom(req);

    const bypassCache = req.query._cb === '1';

    const cacheKey = cacheConfig.generateKey('PRODUCT', {
      featured: true,
      page,
      limit,
      userType,
      storefront
    });

    //  Skip cache if bypass flag is set
    let cachedData = null;
    if (!bypassCache) {
      cachedData = await cacheService.get(cacheKey);
    }
    
    if (cachedData && !bypassCache) {
      res.setHeader('X-Cache', 'HIT');
      setApiCacheHeaders(res);
      return res.json(cachedData);
    }

    const filters = mongoCatalogAnd(storefront, { isFeatured: true });
    const total = await Product.countDocuments(filters);

    const products = await Product.find(filters)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('category')
      .lean({ virtuals: true });

    const productsWithData = await attachAppliedTagsToProducts(
      products.map((product) =>
        decorateProductForStorefront(product, userType, storefront)
      )
    );

    const responseData = {
      success: true,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page * limit < total,
        hasPrevPage: page > 1
      },
      products: productsWithData,
      userType,
      storefront
    };

    await cacheService.set(cacheKey, responseData, cacheConfig.ttl.PRODUCT_FEATURED);

    res.setHeader('X-Cache', 'MISS');
    setApiCacheHeaders(res);
    return res.json(responseData);

  } catch (err) {
    console.error('getFeaturedProducts:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// =============================================
// GET /products/:slug/related - WITH CACHE
// =============================================
const getRelatedProducts = async (req, res) => {
  try {
    const { slug } = req.params;
    const limit = Math.max(1, parseInt(req.query.limit) || 8);
    const userType = req.userType || 'user';
    const storefront = storefrontFrom(req);

    const cacheKey = cacheConfig.generateKey('PRODUCT', {
      related: slug,
      limit,
      userType,
      storefront
    });

    //  CHECK CACHE FIRST
    const cachedData = await cacheService.get(cacheKey);
    if (cachedData) {
      res.setHeader('X-Cache', 'HIT');
      setApiCacheHeaders(res);
      return res.json(cachedData);
    }

    const product = await Product.findOne(
      mongoCatalogAnd(storefront, { slug: String(slug).toLowerCase() })
    );

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    const related = await Product.find(
      mongoCatalogAnd(storefront, {
        _id: { $ne: product._id },
        category: product.category
      })
    )
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('category')
      .lean({ virtuals: true });

    const relatedWithData = await attachAppliedTagsToProducts(
      related.map((rel) =>
        decorateProductForStorefront(rel, userType, storefront)
      )
    );

    const responseData = {
      success: true,
      related: relatedWithData,
      userType,
      storefront
    };

    //  STORE IN CACHE
    await cacheService.set(cacheKey, responseData, cacheConfig.ttl.PRODUCT_RELATED);

    res.setHeader('X-Cache', 'MISS');
    setApiCacheHeaders(res);
    return res.json(responseData);

  } catch (err) {
    console.error('getRelatedProducts:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// =============================================
// GET /products/detailed/:id - NO CACHE (admin/debug use)
// =============================================
const getProductDetails = async (req, res) => {
  try {
    const { id } = req.params;
    const storefront = storefrontFrom(req);
    const product = await Product.findById(id).populate('category');

    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }

    if (!isProductListedOnStorefront(product, storefront)) {
      return res.status(404).json({ message: 'Product not found' });
    }

    const userType = req.userType || 'user';

    const productResponse = await attachAppliedTagsToProduct(
      decorateProductForStorefront(
        product.toObject(),
        userType,
        storefront
      )
    );

    res.status(200).json({
      success: true,
      product: productResponse,
      userType,
      storefront
    });

  } catch (error) {
    console.log(error.message);
    res.status(500).json({ message: 'Error fetching product details', error });
  }
};

module.exports = {
  getProducts, //
  getProductBySlug,
  searchProducts, //
  getProductsByCategory, //
  getFeaturedProducts,
  getRelatedProducts,
  getProductDetails
};
