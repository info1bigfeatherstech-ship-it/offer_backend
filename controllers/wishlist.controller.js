const Wishlist = require('../models/Wishlist');
const Product = require('../models/Product');
const {
  mongoCatalogAnd,
  mongoCatalogListFilter,
  isProductListedOnStorefront,
  isVariantListedOnStorefront
} = require('../utils/storefrontCatalog');
const { findOrCreateCartForStorefront } = require('../services/cartStorefront.service');

const WISHLIST_PRODUCT_SELECT =
  'name slug variants images brand category seo soldInfo fomo hsnCode gstRate isFragile shipping attributes isFeatured status channelStatus createdAt updatedAt';

const storefrontOrDefault = (req) => req.storefront || 'ecomm';


function firstListedVariant(product, storefront) {
  return (product.variants || []).find((v) => isVariantListedOnStorefront(v, storefront)) || null;
}

// ✅ HELPER: Calculate discount percentage
const calculateDiscountPercentage = (base, sale) => {
  if (!sale || sale <= 0 || sale >= base) return 0;
  return Math.round(((base - sale) / base) * 100);
};

// ✅ HELPER: Get variant price based on user type with virtuals
const getVariantPrice = (variant, userType) => {
  if (userType === 'wholesaler') {
    const base = Number(variant.price?.wholesaleBase || 0);
    const wholesaleSaleRaw = variant.price?.wholesaleSale;
    const sale = wholesaleSaleRaw != null ? Number(wholesaleSaleRaw) : null;
    const isSaleActive = sale > 0 && sale < base;
    const discountPercentage = isSaleActive ? calculateDiscountPercentage(base, sale) : 0;
    
    return {
      base: base,
      sale: sale,
      current: isSaleActive ? sale : base,
      isSaleActive: isSaleActive,
      discountPercentage: discountPercentage,
      minimumOrderQuantity: variant.minimumOrderQuantity || 1
    };
  }
  
  // Normal user
  const base = Number(variant.price?.base || 0);
  const retailSaleRaw = variant.price?.sale;
  const sale = retailSaleRaw != null ? Number(retailSaleRaw) : null;
  const isSaleActive = sale && sale > 0 && sale < base;
  const discountPercentage = isSaleActive ? calculateDiscountPercentage(base, sale) : 0;
  
  return {
    base: base,
    sale: sale,
    current: isSaleActive ? sale : base,
    isSaleActive: isSaleActive,
    discountPercentage: discountPercentage,
    minimumOrderQuantity: 1
  };
};

// ✅ HELPER: Format variant with all virtual fields
const formatVariantWithVirtuals = (variant, userType) => {
  const price = getVariantPrice(variant, userType);
  
  return {
    _id: variant._id,
    sku: variant.sku,
    productCode: variant.productCode,
    attributes: variant.attributes || [],
    images: variant.images || [],
    inventory: variant.inventory || {},
    price: {
      base: price.base,
      sale: price.sale,
      current: price.current,
      isSaleActive: price.isSaleActive,
      discountPercentage: price.discountPercentage,
      minimumOrderQuantity: userType === 'wholesaler' ? (variant.minimumOrderQuantity || 1) : 1
    },
    isActive: variant.isActive,
    wholesale: variant.wholesale || false,
    minimumOrderQuantity: variant.minimumOrderQuantity || 1,
    // ✅ Virtual fields
    isSaleActive: price.isSaleActive,
    finalPrice: price.current,
    discountPercentage: price.discountPercentage
  };
};

// ✅ HELPER: Format wishlist item response (SAME AS CART RESPONSE)
const formatWishlistItem = (item, userType, storefront) => {
  const product = item.productId;
  if (!product) return null;

  let variant = null;
  if (item.variantId) {
    variant = product.variants?.find((v) => String(v._id) === String(item.variantId));
    if (variant && !isVariantListedOnStorefront(variant, storefront)) {
      return null;
    }
  }

  if (!variant) {
    variant = firstListedVariant(product, storefront);
  }

  if (!variant) return null;
  
  // ✅ Format variant with all virtuals
  const formattedVariant = formatVariantWithVirtuals(variant, userType);
  
  // ✅ FULL PRODUCT RESPONSE with variants array
  const productObj = product.toObject ? product.toObject() : product;
  
  return {
    _id: item._id,
    addedAt: item.addedAt,
    product: {
      ...productObj,
      variants: [formattedVariant] // Only the selected variant in wishlist
    }
  };
};

// =============================================
// GET WISHLIST
// =============================================
const getWishlist = async (req, res) => {
  try {
    const userId = req.userId;
    const userType = req.userType || 'user';
    const storefront = storefrontOrDefault(req);

    const wishlist = await Wishlist.findOne({ userId })
      .populate({
        path: 'products.productId',
        select: WISHLIST_PRODUCT_SELECT
      });

    if (!wishlist) {
      return res.json({
        success: true,
        wishlist: { products: [] },
        userType,
        storefront
      });
    }

    const formattedProducts = wishlist.products
      .map((item) => formatWishlistItem(item, userType, storefront))
      .filter((item) => item !== null);

    return res.json({
      success: true,
      wishlist: {
        _id: wishlist._id,
        userId: wishlist.userId,
        products: formattedProducts,
        createdAt: wishlist.createdAt,
        updatedAt: wishlist.updatedAt
      },
      userType,
      storefront
    });

  } catch (err) {
    console.error('getWishlist:', err);
    return res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// =============================================
// ADD TO WISHLIST
// =============================================
const addToWishlist = async (req, res) => {
  try {
    const userId = req.userId;
    const { productSlug, variantId } = req.body;
    const userType = req.userType || 'user';
    const storefront = storefrontOrDefault(req);

    if (!productSlug) {
      return res.status(400).json({ 
        success: false, 
        message: 'productSlug required' 
      });
    }

    const product = await Product.findOne(
      mongoCatalogAnd(storefront, { slug: productSlug.toLowerCase() })
    ).select(WISHLIST_PRODUCT_SELECT);

    if (!product) {
      return res.status(404).json({ 
        success: false, 
        message: 'Product not found' 
      });
    }

    let chosenVariantId = variantId;
    if (chosenVariantId) {
      const v = product.variants.find((x) => String(x._id) === String(chosenVariantId));
      if (!v || !isVariantListedOnStorefront(v, storefront)) {
        return res.status(400).json({ 
          success: false, 
          message: 'Variant not found or inactive' 
        });
      }
    } else {
      const first = firstListedVariant(product, storefront);
      if (!first) {
        return res.status(400).json({ 
          success: false, 
          message: 'No active variant available' 
        });
      }
      chosenVariantId = first._id;
    }

    // Check if already in wishlist
    const existingWishlist = await Wishlist.findOne({ userId });
    if (existingWishlist) {
      const alreadyExists = existingWishlist.products.some(p => 
        String(p.productId) === String(product._id) &&
        String(p.variantId) === String(chosenVariantId)
      );
      
      if (alreadyExists) {
        return res.status(400).json({ 
          success: false, 
          message: 'Product already in wishlist' 
        });
      }
    }

    // Add to wishlist
    await Wishlist.updateOne(
      { userId },
      {
        $addToSet: {
          products: { productId: product._id, variantId: chosenVariantId }
        }
      },
      { upsert: true }
    );

    // Get updated wishlist with full data
    const updatedWishlist = await Wishlist.findOne({ userId })
      .populate({
        path: 'products.productId',
        select: WISHLIST_PRODUCT_SELECT
      });

    const formattedProducts = updatedWishlist.products
      .map((item) => formatWishlistItem(item, userType, storefront))
      .filter((item) => item !== null);

    return res.json({ 
      success: true, 
      message: 'Added to wishlist',
      wishlist: {
        _id: updatedWishlist._id,
        userId: updatedWishlist.userId,
        products: formattedProducts,
        createdAt: updatedWishlist.createdAt,
        updatedAt: updatedWishlist.updatedAt
      },
      userType,
      storefront
    });

  } catch (err) {
    console.error('addToWishlist:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// =============================================
// REMOVE FROM WISHLIST
// =============================================
const removeFromWishlist = async (req, res) => {
  try {
    const { productSlug } = req.params;
    const userId = req.userId;
    const userType = req.userType || 'user';
    const storefront = storefrontOrDefault(req);

    if (!productSlug) {
      return res.status(400).json({ 
        success: false, 
        message: 'productSlug required' 
      });
    }

    const product = await Product.findOne({
      slug: productSlug.toLowerCase()
    }).select('_id');

    if (!product) {
      return res.status(404).json({ 
        success: false, 
        message: 'Product not found' 
      });
    }

    await Wishlist.updateOne(
      { userId },
      { $pull: { products: { productId: product._id } } }
    );

    // Get updated wishlist
    const updatedWishlist = await Wishlist.findOne({ userId })
      .populate({
        path: 'products.productId',
        select: WISHLIST_PRODUCT_SELECT
      });

    if (!updatedWishlist) {
      return res.json({ 
        success: true, 
        wishlist: { products: [] },
        userType,
        storefront
      });
    }

    const formattedProducts = updatedWishlist.products
      .map((item) => formatWishlistItem(item, userType, storefront))
      .filter((item) => item !== null);

    return res.json({
      success: true,
      wishlist: {
        _id: updatedWishlist._id,
        userId: updatedWishlist.userId,
        products: formattedProducts,
        createdAt: updatedWishlist.createdAt,
        updatedAt: updatedWishlist.updatedAt
      },
      userType,
      storefront
    });

  } catch (err) {
    console.error('removeFromWishlist:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// =============================================
// MOVE TO CART
// =============================================
const moveToCart = async (req, res) => {
  const userId = req.userId;
  const userType = req.userType || 'user';
  const storefront = storefrontOrDefault(req);
  const { moveAll = false } = req.body;

  const normalizeIds = (raw) => {
    if (Array.isArray(raw)) {
      return raw.map((v) => String(v || '').trim()).filter(Boolean);
    }
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (!trimmed) return [];
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed.map((v) => String(v || '').trim()).filter(Boolean);
        }
      } catch (_) {
        // fall through to comma-separated parsing
      }
      return trimmed
        .split(',')
        .map((v) => String(v || '').trim())
        .filter(Boolean);
    }
    return [];
  };
  const productIds = normalizeIds(req.body?.productIds);
  const selectedIdSet = new Set(productIds);

  if (!userId)
    return res.status(401).json({ success: false, message: 'Unauthorized' });

  try {
    const wishlist = await Wishlist.findOne({ userId });

    if (!wishlist || !wishlist.products.length)
      return res.status(400).json({ success: false, message: 'Wishlist empty' });

    let itemsToMove = [];

    if (moveAll) {
      itemsToMove = wishlist.products;
    } else {
      itemsToMove = wishlist.products.filter((p) =>
        selectedIdSet.has(String(p.productId)) || selectedIdSet.has(String(p._id))
      );
    }

    if (!itemsToMove.length)
      return res.status(400).json({ success: false, message: 'No items selected' });

    const productIdsList = itemsToMove.map((item) => item.productId);
    const rawProducts = await Product.find({
      _id: { $in: productIdsList }
    }).select('name slug variants images brand channelStatus status');

    const productMap = new Map();
    rawProducts.forEach((product) => {
      if (isProductListedOnStorefront(product, storefront)) {
        productMap.set(String(product._id), product);
      }
    });

    let cartDoc = await findOrCreateCartForStorefront(userId, storefront);

    for (const item of itemsToMove) {
      const product = productMap.get(String(item.productId));
      if (!product) continue;

      // Find the variant
      let variant = null;
      if (item.variantId) {
        variant = product.variants.find((v) => String(v._id) === String(item.variantId));
      }
      if (!variant) {
        variant = firstListedVariant(product, storefront);
      }
      if (!variant || !isVariantListedOnStorefront(variant, storefront)) continue;

      // Calculate price based on user type (with discount)
      let basePrice, salePrice, isSaleActive, discountPercentage;
      if (userType === 'wholesaler') {
        basePrice = variant.price?.wholesaleBase || variant.price?.base || 0;
        salePrice = variant.price?.wholesaleSale || variant.price?.wholesaleBase || variant.price?.base || 0;
        isSaleActive = salePrice > 0 && salePrice < basePrice;
        discountPercentage = isSaleActive ? calculateDiscountPercentage(basePrice, salePrice) : 0;
      } else {
        basePrice = variant.price?.base || 0;
        salePrice = variant.price?.sale || null;
        isSaleActive = salePrice && salePrice > 0 && salePrice < basePrice;
        discountPercentage = isSaleActive ? calculateDiscountPercentage(basePrice, salePrice) : 0;
      }

      const existing = cartDoc.items.find(it =>
        String(it.productId) === String(product._id) &&
        String(it.variantId) === String(variant._id)
      );

      if (existing) {
        const qtyToAdd = userType === 'wholesaler'
          ? Math.max(1, Number(variant.minimumOrderQuantity || 1))
          : 1;
        existing.quantity += qtyToAdd;
      } else {
        const initialQuantity = userType === 'wholesaler'
          ? Math.max(1, Number(variant.minimumOrderQuantity || 1))
          : 1;
        cartDoc.items.push({
          productId: product._id,
          variantId: variant._id,
          quantity: initialQuantity,
          priceSnapshot: {
            base: basePrice,
            sale: salePrice,
            isSaleActive: isSaleActive,
            discountPercentage: discountPercentage,
            costPrice: variant.price?.costPrice ?? null,
            saleStartDate: variant.price?.saleStartDate ?? null,
            saleEndDate: variant.price?.saleEndDate ?? null
          },
          variantAttributesSnapshot: (variant.attributes || []).map(a => ({
            key: a.key,
            value: a.value
          }))
        });
      }
    }

    cartDoc.calculateTotal();
    await cartDoc.save();

    // Remove moved items from wishlist
    if (moveAll) {
      wishlist.products = [];
    } else {
      wishlist.products = wishlist.products.filter((p) =>
        !(selectedIdSet.has(String(p.productId)) || selectedIdSet.has(String(p._id)))
      );
    }

    await wishlist.save();

    return res.json({
      success: true,
      message: 'Wishlist items moved to cart',
      cart: cartDoc,
      userType,
      storefront
    });

  } catch (err) {
    console.error('moveWishlistTocart:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// =============================================
// MERGE WISHLIST (Guest to User)
// =============================================
const mergeWishlist = async (req, res) => {
  try {
    const userId = req.userId;
    const storefront = storefrontOrDefault(req);
    let { slugs, items } = req.body;

    // Handle old format (slugs array)
    if (slugs && Array.isArray(slugs) && slugs.length > 0) {
      items = slugs.map(slug => ({ slug, variantId: null }));
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid request. Provide slugs array or items array with { slug, variantId }' 
      });
    }

    // Normalize items
    const normalizedItems = [];
    for (const item of items) {
      if (typeof item === 'string') {
        normalizedItems.push({ slug: item, variantId: null });
      } else if (typeof item === 'object' && item.slug) {
        normalizedItems.push({ 
          slug: item.slug, 
          variantId: item.variantId || null 
        });
      }
    }

    if (normalizedItems.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'No valid items to merge' 
      });
    }

    const slugsList = normalizedItems.map((item) => item.slug.toLowerCase());
    const products = await Product.find({
      $and: [...mongoCatalogListFilter(storefront).$and, { slug: { $in: slugsList } }]
    }).select('slug variants channelStatus status');

    const productMap = new Map();
    products.forEach((product) => {
      productMap.set(product.slug, product);
    });

    const productEntries = [];

    for (const item of normalizedItems) {
      const product = productMap.get(item.slug.toLowerCase());
      if (!product) continue;

      let chosenVariantId = item.variantId;
      
      if (!chosenVariantId) {
        const first = firstListedVariant(product, storefront);
        if (first) {
          chosenVariantId = first._id;
        } else {
          continue;
        }
      } else {
        const v = product.variants.find((x) => String(x._id) === String(chosenVariantId));
        if (!v || !isVariantListedOnStorefront(v, storefront)) continue;
      }

      // Check if already in wishlist
      const existingWishlist = await Wishlist.findOne({ userId });
      if (existingWishlist) {
        const alreadyExists = existingWishlist.products.some(p => 
          String(p.productId) === String(product._id) &&
          String(p.variantId) === String(chosenVariantId)
        );
        if (alreadyExists) continue;
      }

      productEntries.push({
        productId: product._id,
        variantId: chosenVariantId
      });
    }

    if (productEntries.length === 0) {
      return res.json({ 
        success: true, 
        message: "No new products to add to wishlist" 
      });
    }

    await Wishlist.updateOne(
      { userId },
      {
        $addToSet: {
          products: { $each: productEntries }
        }
      },
      { upsert: true }
    );

    return res.json({ 
      success: true, 
      message: `${productEntries.length} item(s) added to wishlist`,
      mergedCount: productEntries.length
    });

  } catch (err) {
    console.error('mergeWishlist:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// =============================================
// BULK REMOVE FROM WISHLIST
// =============================================
const removeBulkFromWishlist = async (req, res) => {
  try {
    const userId = req.userId;
    const { slugs } = req.body;
    const userType = req.userType || 'user';

    if (!Array.isArray(slugs) || slugs.length === 0) {
      return res.status(400).json({
        success: false,
        message: "slugs array required"
      });
    }

    const storefront = storefrontOrDefault(req);
    const products = await Product.find({
      slug: { $in: slugs.map((s) => s.toLowerCase()) }
    }).select('_id');

    const productIds = products.map(p => p._id);

    if (productIds.length > 0) {
      await Wishlist.updateOne(
        { userId },
        {
          $pull: {
            products: { productId: { $in: productIds } }
          }
        }
      );
    }

    const updatedWishlist = await Wishlist.findOne({ userId })
      .populate({
        path: 'products.productId',
        select: WISHLIST_PRODUCT_SELECT
      });

    if (!updatedWishlist) {
      return res.json({
        success: true,
        wishlist: { products: [] },
        userType,
        storefront
      });
    }

    const formattedProducts = updatedWishlist.products
      .map((item) => formatWishlistItem(item, userType, storefront))
      .filter((item) => item !== null);

    return res.json({
      success: true,
      wishlist: {
        _id: updatedWishlist._id,
        userId: updatedWishlist.userId,
        products: formattedProducts,
        createdAt: updatedWishlist.createdAt,
        updatedAt: updatedWishlist.updatedAt
      },
      userType,
      storefront
    });

  } catch (err) {
    console.error("removeBulkFromWishlist:", err);
    return res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
};

// =============================================
// CLEAR WISHLIST
// =============================================
const clearWishlist = async (req, res) => {
  try {
    const userId = req.userId;
    const userType = req.userType || 'user';
    const storefront = storefrontOrDefault(req);

    const wishlist = await Wishlist.findOneAndUpdate(
      { userId },
      { $set: { products: [] } },
      { new: true }
    ).lean();

    return res.json({
      success: true,
      message: "Wishlist cleared",
      wishlist: wishlist || { products: [] },
      userType,
      storefront
    });

  } catch (err) {
    console.error("clearWishlist:", err);
    return res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
};

module.exports = {
  getWishlist,
  addToWishlist,
  removeFromWishlist,
  moveToCart,
  mergeWishlist,
  removeBulkFromWishlist,
  clearWishlist
};