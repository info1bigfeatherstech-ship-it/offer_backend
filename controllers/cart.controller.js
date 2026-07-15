const mongoose = require('mongoose');
const Cart = require('../models/cart');
const Product = require('../models/Product');
const Order = require('../models/Order');
const Address = require('../models/Address');
const {
  mongoCatalogAnd,
  isProductListedOnStorefront,
  isVariantListedOnStorefront
} = require('../utils/storefrontCatalog');
const { sanitizeCartItems } = require('../services/cartSanitize.service');
const { findCartForStorefront, findOrCreateCartForStorefront } = require('../services/cartStorefront.service');

const CART_PRODUCT_SELECT =
  'name slug title description brand category seo soldInfo fomo hsnCode gstRate isFragile shipping attributes isFeatured status channelStatus createdAt updatedAt variants';

const storefrontOrDefault = (req) => req.storefront || 'ecomm';


function firstListedVariant(product, storefront) {
  return (product.variants || []).find((v) => isVariantListedOnStorefront(v, storefront)) || null;
}

// Helper: find variant object inside product document
const findVariant = (product, variantId) => {
  if (!product || !product.variants) return null;
  return product.variants.find(v => String(v._id) === String(variantId));
};

// Helper: compute if sale is valid for a price snapshot
const isSaleValid = (price) => {
  if (!price) return false;
  const now = new Date();
  if (price.sale == null) return false;
  if (price.sale >= price.base) return false;
  if (price.saleStartDate && now < price.saleStartDate) return false;
  if (price.saleEndDate && now > price.saleEndDate) return false;
  return true;
};

// Helper: Get storefront-specific pricing for a variant
const getStorefrontSpecificPrice = (variant, storefront) => {
  if (storefront === 'wholesale') {
    const wholesaleBase = Number(variant.price?.wholesaleBase || 0);
    const wholesaleSaleRaw = variant.price?.wholesaleSale;
    const wholesaleSale = wholesaleSaleRaw != null ? Number(wholesaleSaleRaw) : null;
    return {
      base: wholesaleBase,
      sale: Number.isFinite(wholesaleSale) ? wholesaleSale : null,
      moq: variant.minimumOrderQuantity || 1
    };
  }
  const retailSaleRaw = variant.price?.sale;
  const retailSale = retailSaleRaw != null ? Number(retailSaleRaw) : null;
  return {
    base: variant.price?.base || 0,
    sale: Number.isFinite(retailSale) ? retailSale : null,
    moq: 1
  };
};

//  HELPER: Calculate discount percentage
const calculateDiscountPercentage = (base, sale) => {
  if (!sale || sale <= 0 || sale >= base) return 0;
  return Math.round(((base - sale) / base) * 100);
};

//  HELPER: Format cart item with FULL variant data (including virtuals)
const formatcartItem = (item, product, variant, storefront) => {
  if (!product || !variant) return null;
  
  const price = getStorefrontSpecificPrice(variant, storefront);
  
  // Calculate sale validity and discount
  const isSaleValidForVariant = price.sale && price.sale > 0 && price.sale < price.base;
  const discountPercentage = isSaleValidForVariant 
    ? calculateDiscountPercentage(price.base, price.sale)
    : 0;
  
  // Calculate current price
  let currentPrice = isSaleValidForVariant ? price.sale : price.base;
  
  const itemTotal = currentPrice * item.quantity;
  
  //  FULL VARIANT OBJECT with all data including virtuals
  const fullVariant = {
    _id: variant._id,
    sku: variant.sku,
    productCode: variant.productCode,
    attributes: variant.attributes || [],
    images: variant.images || [],
    inventory: variant.inventory || {},
    price: {
      base: price.base,
      sale: price.sale,
      current: currentPrice,
      isSaleActive: isSaleValidForVariant,
      discountPercentage,
      minimumOrderQuantity: storefront === 'wholesale' ? (variant.minimumOrderQuantity || 1) : 1
    },
    isActive: variant.isActive,
    wholesale: variant.wholesale || false,
    minimumOrderQuantity: variant.minimumOrderQuantity || 1,
    //  ADD VIRTUALS HERE
    isSaleActive: isSaleValidForVariant,
    finalPrice: currentPrice,
    discountPercentage: discountPercentage
  };
  
  //  FULL PRODUCT OBJECT with variants array
  const fullProduct = {
    _id: product._id,
    name: product.name,
    slug: product.slug,
    title: product.title,
    description: product.description,
    brand: product.brand,
    category: product.category,
    seo: product.seo,
    soldInfo: product.soldInfo,
    fomo: product.fomo,
    hsnCode: product.hsnCode,
    gstRate: product.gstRate,
    isFragile: product.isFragile,
    shipping: product.shipping,
    attributes: product.attributes,
    isFeatured: product.isFeatured,
    status: product.status,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
    variants: [fullVariant]
  };
  
  return {
    _id: item._id,
    productId: product._id,
    variantId: variant._id,
    quantity: item.quantity,
    price: {
      base: price.base,
      sale: price.sale,
      current: currentPrice,
      discountPercentage: discountPercentage,
      isSaleActive: isSaleValidForVariant
    },
    product: fullProduct,
    total: itemTotal
  };
};

// =============================================
// GET CART
// =============================================
const getcart = async (req, res) => {
  const userId = req.userId;
  const userType = req.userType || 'user';

  try {
    const storefront = storefrontOrDefault(req);

    let cartDoc = await findCartForStorefront(userId, storefront);
    if (cartDoc?.items?.length) {
      await sanitizeCartItems(cartDoc, storefront, { persist: true });
    }

    const cart = await findCartForStorefront(userId, storefront)
      .populate({
        path: 'items.productId',
        select: CART_PRODUCT_SELECT
      })
      .lean();

    if (!cart) {
      return res.json({ 
        success: true, 
        cart: { items: [], totalAmount: 0 },
        userType: userType,
        storefront
      });
    }

    //  Format each item with full data
    const itemsWithFullData = [];
    
    for (const item of cart.items) {
      const product = item.productId;
      if (!product) continue;
      
      let variant = null;
      if (item.variantId) {
        variant = product.variants?.find(v => String(v._id) === String(item.variantId));
        if (variant && !isVariantListedOnStorefront(variant, storefront)) {
          variant = null;
        }
      }
      
      if (!variant) {
        variant = firstListedVariant(product, storefront);
      }
      
      if (!variant) continue;
      
      const formattedItem = formatcartItem(item, product, variant, storefront);
      if (formattedItem) {
        itemsWithFullData.push(formattedItem);
      }
    }
    
    // Calculate total
    const totalAmount = itemsWithFullData.reduce((sum, item) => sum + item.total, 0);
    
    // Calculate total discount
    const totalOriginalAmount = itemsWithFullData.reduce((sum, item) => {
      const originalPrice = item.price.base;
      return sum + (originalPrice * item.quantity);
    }, 0);
    
    const totalDiscount = totalOriginalAmount - totalAmount;
    const totalDiscountPercentage = totalOriginalAmount > 0 
      ? Math.round((totalDiscount / totalOriginalAmount) * 100)
      : 0;

    return res.json({
      success: true,
      cart: {
        _id: cart._id,
        userId: cart.userId,
        items: itemsWithFullData,
        totalAmount: totalAmount,
        totalOriginalAmount: totalOriginalAmount,
        totalDiscount: totalDiscount,
        totalDiscountPercentage: totalDiscountPercentage,
        createdAt: cart.createdAt,
        updatedAt: cart.updatedAt
      },
      userType,
      storefront
    });

  } catch (err) {
    console.error('getcart:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// =============================================
// ADD TO CART
// =============================================
const addTocart = async (req, res) => {
  const userId = req.userId;
  const userType = req.userType || 'user';
  const storefront = storefrontOrDefault(req);
  const { productId, productSlug, variantId, quantity = 1 } = req.body;

  if (!userId) {
    return res.status(401).json({ 
      success: false, 
      message: 'Unauthorized' 
    });
  }

  try {
    // Resolve product
    let product;
    if (productId && mongoose.Types.ObjectId.isValid(productId)) {
      product = await Product.findById(productId).select(CART_PRODUCT_SELECT);
    } else if (productSlug) {
      product = await Product.findOne(
        mongoCatalogAnd(storefront, { slug: String(productSlug).toLowerCase() })
      ).select(CART_PRODUCT_SELECT);
    }

    if (!product) {
      return res.status(404).json({ 
        success: false, 
        message: 'Product not found' 
      });
    }
    
    if (!isProductListedOnStorefront(product, storefront)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Product not active' 
      });
    }

    // Find variant
    let variant = null;
    
    if (variantId) {
      variant = findVariant(product, variantId);
      if (!variant || !isVariantListedOnStorefront(variant, storefront)) {
        return res.status(400).json({ 
          success: false, 
          message: 'Invalid variantId. Variant not found or inactive.' 
        });
      }
    } else {
      variant = firstListedVariant(product, storefront);
      if (!variant) {
        return res.status(404).json({ 
          success: false, 
          message: 'No active variant available for this product' 
        });
      }
    }

    // Check MOQ for wholesale storefront cart operations
    if (storefront === 'wholesale') {
      const moq = variant.minimumOrderQuantity || 1;
      if (quantity < moq) {
        return res.status(400).json({
          success: false,
          message: `Minimum order quantity for this product is ${moq}`
        });
      }
    }

    // Stock validation
    if (variant.inventory?.trackInventory) {
      const available = Number(variant.inventory.quantity || 0);
      if (available < quantity) {
        return res.status(400).json({ 
          success: false, 
          message: 'Insufficient stock for variant' 
        });
      }
    }

    // Prepare price snapshot based on storefront policy
    const price = getStorefrontSpecificPrice(variant, storefront);
    
    const priceSnapshot = {
      base: price.base,
      sale: price.sale,
      costPrice: variant.price?.costPrice ?? null,
      saleStartDate: variant.price?.saleStartDate ?? null,
      saleEndDate: variant.price?.saleEndDate ?? null
    };

    const variantAttrSnapshot = (variant.attributes || []).map(a => ({ 
      key: a.key, 
      value: a.value 
    }));

    // Upsert cart and item
    let cart = await findOrCreateCartForStorefront(userId, storefront);

    // Check existing same item
    const existing = cart.items.find(it => 
      String(it.productId) === String(product._id) && 
      String(it.variantId) === String(variant._id)
    );
    
    if (existing) {
      const newQty = existing.quantity + Number(quantity);
      if (variant.inventory?.trackInventory) {
        if (variant.inventory.quantity < newQty) {
          return res.status(400).json({ 
            success: false, 
            message: 'Insufficient stock for requested quantity' 
          });
        }
      }
      existing.quantity = newQty;
      existing.priceSnapshot = priceSnapshot;
      existing.variantAttributesSnapshot = variantAttrSnapshot;
    } else {
      cart.items.push({ 
        productId: product._id, 
        variantId: variant._id, 
        quantity: Number(quantity), 
        priceSnapshot, 
        variantAttributesSnapshot: variantAttrSnapshot 
      });
    }

    cart.calculateTotal();
    await cart.save();

    // Return cart with full data
    const updatedcart = await findCartForStorefront(userId, storefront)
      .populate({
        path: 'items.productId',
        select: CART_PRODUCT_SELECT
      });

    // Format response
    const formattedItems = [];
    for (const item of updatedcart.items) {
      const prod = item.productId;
      if (!prod) continue;
      
      let varObj = null;
      if (item.variantId) {
        varObj = prod.variants?.find(v => String(v._id) === String(item.variantId));
      }
      if (!varObj) {
        varObj = firstListedVariant(prod, storefront);
      }
      if (!varObj) continue;
      
      const formatted = formatcartItem(item, prod, varObj, storefront);
      if (formatted) formattedItems.push(formatted);
    }
    
    const totalAmt = formattedItems.reduce((sum, it) => sum + it.total, 0);
    const totalOriginalAmt = formattedItems.reduce((sum, it) => sum + (it.price.base * it.quantity), 0);
    const totalDisc = totalOriginalAmt - totalAmt;
    const totalDiscPerc = totalOriginalAmt > 0 ? Math.round((totalDisc / totalOriginalAmt) * 100) : 0;

    return res.json({ 
      success: true, 
      cart: {
        _id: updatedcart._id,
        userId: updatedcart.userId,
        items: formattedItems,
        totalAmount: totalAmt,
        totalOriginalAmount: totalOriginalAmt,
        totalDiscount: totalDisc,
        totalDiscountPercentage: totalDiscPerc,
        createdAt: updatedcart.createdAt,
        updatedAt: updatedcart.updatedAt
      },
      userType,
      storefront
    });
    
  } catch (err) {
    console.error('addTocart:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// =============================================
// UPDATE CART ITEM
// =============================================
const updatecartItem = async (req, res) => {
  const userId = req.userId;
  const userType = req.userType || 'user';
  const storefront = storefrontOrDefault(req);
  const { productId, variantId, quantity } = req.body;

  if (!userId) {
    return res.status(401).json({ 
      success: false, 
      message: 'Unauthorized' 
    });
  }
  
  if (!productId || !variantId) {
    return res.status(400).json({ 
      success: false, 
      message: 'productId and variantId required' 
    });
  }

  try {
    const cart = await findCartForStorefront(userId, storefront);
    if (!cart) {
      return res.status(404).json({ 
        success: false, 
        message: 'cart not found' 
      });
    }

    const item = cart.items.find(it => 
      String(it.productId) === String(productId) && 
      String(it.variantId) === String(variantId)
    );
    
    if (!item) {
      return res.status(404).json({ 
        success: false, 
        message: 'Item not in cart' 
      });
    }

    if (quantity <= 0) {
      cart.items = cart.items.filter(it => 
        !(String(it.productId) === String(productId) && 
          String(it.variantId) === String(variantId))
      );
      cart.calculateTotal();
      await cart.save();
      
      const updatedcart = await findCartForStorefront(userId, storefront)
        .populate({ 
          path: 'items.productId', 
          select: CART_PRODUCT_SELECT
        });
      
      // Format response
      const formattedItems = [];
      for (const it of updatedcart.items) {
        const prod = it.productId;
        if (!prod) continue;
        let varObj = prod.variants?.find(v => String(v._id) === String(it.variantId));
        if (!varObj) varObj = firstListedVariant(prod, storefront);
        if (!varObj) continue;
        const formatted = formatcartItem(it, prod, varObj, storefront);
        if (formatted) formattedItems.push(formatted);
      }
      
      const totalAmt = formattedItems.reduce((sum, it) => sum + it.total, 0);
      const totalOriginalAmt = formattedItems.reduce((sum, it) => sum + (it.price.base * it.quantity), 0);
      const totalDisc = totalOriginalAmt - totalAmt;
      const totalDiscPerc = totalOriginalAmt > 0 ? Math.round((totalDisc / totalOriginalAmt) * 100) : 0;
      
      return res.json({ 
        success: true, 
        cart: {
          ...updatedcart.toObject(),
          items: formattedItems,
          totalAmount: totalAmt,
          totalOriginalAmount: totalOriginalAmt,
          totalDiscount: totalDisc,
          totalDiscountPercentage: totalDiscPerc
        },
        userType,
        storefront
      });
    }

    // Re-check live stock and pricing
    const product = await Product.findById(productId).select(CART_PRODUCT_SELECT);
    const variant = findVariant(product, variantId);
    if (!variant || !isProductListedOnStorefront(product, storefront) || !isVariantListedOnStorefront(variant, storefront)) {
      return res.status(404).json({ 
        success: false, 
        message: 'Variant not found' 
      });
    }

    // Check MOQ for wholesale storefront cart operations
    if (storefront === 'wholesale') {
      const moq = variant.minimumOrderQuantity || 1;
      if (quantity < moq) {
        return res.status(400).json({
          success: false,
          message: `Minimum order quantity for this product is ${moq}`
        });
      }
    }

    if (variant.inventory?.trackInventory && variant.inventory.quantity < quantity) {
      return res.status(400).json({ 
        success: false, 
        message: 'Insufficient stock' 
      });
    }

    // Refresh price snapshot based on storefront policy
    const price = getStorefrontSpecificPrice(variant, storefront);

    item.quantity = Number(quantity);
    item.priceSnapshot = {
      base: price.base,
      sale: price.sale,
      costPrice: variant.price?.costPrice ?? null,
      saleStartDate: variant.price?.saleStartDate ?? null,
      saleEndDate: variant.price?.saleEndDate ?? null
    };
    item.variantAttributesSnapshot = (variant.attributes || []).map(a => ({ 
      key: a.key, 
      value: a.value 
    }));

    cart.calculateTotal();
    await cart.save();

    // Populate for response
    const populatedcart = await findCartForStorefront(userId, storefront)
      .populate({ 
        path: 'items.productId', 
        select: CART_PRODUCT_SELECT
      });

    // Format response
    const formattedItems = [];
    for (const it of populatedcart.items) {
      const prod = it.productId;
      if (!prod) continue;
      let varObj = prod.variants?.find(v => String(v._id) === String(it.variantId));
      if (!varObj) varObj = firstListedVariant(prod, storefront);
      if (!varObj) continue;
      const formatted = formatcartItem(it, prod, varObj, storefront);
      if (formatted) formattedItems.push(formatted);
    }
    
    const totalAmt = formattedItems.reduce((sum, it) => sum + it.total, 0);
    const totalOriginalAmt = formattedItems.reduce((sum, it) => sum + (it.price.base * it.quantity), 0);
    const totalDisc = totalOriginalAmt - totalAmt;
    const totalDiscPerc = totalOriginalAmt > 0 ? Math.round((totalDisc / totalOriginalAmt) * 100) : 0;

    return res.json({ 
      success: true, 
      cart: {
        ...populatedcart.toObject(),
        items: formattedItems,
        totalAmount: totalAmt,
        totalOriginalAmount: totalOriginalAmt,
        totalDiscount: totalDisc,
        totalDiscountPercentage: totalDiscPerc
      },
      userType,
      storefront
    });
    
  } catch (err) {
    console.error('updatecartItem:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// =============================================
// MERGE CART (Guest cart after login) - Simplified version
// =============================================
const mergecart = async (req, res) => {
  const userId = req.userId;
  const userType = req.userType || 'user';
  const storefront = storefrontOrDefault(req);
  const { items } = req.body;

  if (!userId) {
    return res.status(401).json({ 
      success: false, 
      message: "Unauthorized" 
    });
  }

  if (!Array.isArray(items)) {
    return res.status(400).json({ 
      success: false, 
      message: "Invalid items" 
    });
  }

  try {
    let cart = await findOrCreateCartForStorefront(userId, storefront);

    for (const incoming of items) {
      let { productId, variantId, quantity, productSlug } = incoming;
      if ((!productId && !productSlug) || !variantId || quantity <= 0) continue;

      let product = null;
      if (productId && mongoose.Types.ObjectId.isValid(String(productId))) {
        product = await Product.findById(productId).select(CART_PRODUCT_SELECT);
      }
      if (!product && productSlug) {
        product = await Product.findOne(
          mongoCatalogAnd(storefront, { slug: String(productSlug).toLowerCase().trim() })
        ).select(CART_PRODUCT_SELECT);
      }
      if (!product || !isProductListedOnStorefront(product, storefront)) continue;

      productId = product._id;

      const variant = product.variants.find(v => String(v._id) === String(variantId));
      if (!variant || !isVariantListedOnStorefront(variant, storefront)) continue;

      let qty = Number(quantity);
      if (qty <= 0) continue;

      const existing = cart.items.find(
        it => String(it.productId) === String(productId) && 
              String(it.variantId) === String(variantId)
      );

      if (existing) {
        existing.quantity += qty;
      } else {
        if (storefront === 'wholesale') {
          const moq = Number(variant.minimumOrderQuantity || 1);
          qty = Math.max(qty, moq);
        }
        const price = getStorefrontSpecificPrice(variant, storefront);
        cart.items.push({
          productId,
          variantId,
          quantity: qty,
          priceSnapshot: {
            base: price.base,
            sale: price.sale,
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

    cart.calculateTotal();
    await cart.save();

    // Return updated cart
    const populatedcart = await findCartForStorefront(userId, storefront)
      .populate({ 
        path: 'items.productId', 
        select: CART_PRODUCT_SELECT
      });

    const formattedItems = [];
    for (const it of populatedcart?.items || []) {
      const prod = it.productId;
      if (!prod) continue;
      let varObj = prod.variants?.find(v => String(v._id) === String(it.variantId));
      if (!varObj) varObj = firstListedVariant(prod, storefront);
      if (!varObj) continue;
      const formatted = formatcartItem(it, prod, varObj, storefront);
      if (formatted) formattedItems.push(formatted);
    }

    const totalAmt = formattedItems.reduce((sum, it) => sum + it.total, 0);
    const totalOriginalAmt = formattedItems.reduce((sum, it) => sum + (it.price.base * it.quantity), 0);
    const totalDisc = totalOriginalAmt - totalAmt;
    const totalDiscPerc = totalOriginalAmt > 0 ? Math.round((totalDisc / totalOriginalAmt) * 100) : 0;

    return res.json({ 
      success: true, 
      cart: populatedcart ? {
        ...populatedcart.toObject(),
        items: formattedItems,
        totalAmount: totalAmt,
        totalOriginalAmount: totalOriginalAmt,
        totalDiscount: totalDisc,
        totalDiscountPercentage: totalDiscPerc
      } : { items: [], totalAmount: 0 },
      userType,
      storefront
    });

  } catch (err) {
    console.error("mergecart error:", err);
    return res.status(500).json({ 
      success: false, 
      message: "Merge failed",
      error: err.message 
    });
  }
};

// =============================================
// REMOVE SINGLE ITEM FROM CART
// =============================================
const removecartItem = async (req, res) => {
  const userId = req.userId;
  const userType = req.userType || 'user';
  const storefront = storefrontOrDefault(req);
  const { productId, variantId } = req.body;

  try {
    const cart = await findCartForStorefront(userId, storefront);
    if (!cart) {
      return res.status(404).json({ 
        success: false, 
        message: 'cart not found' 
      });
    }

    cart.items = cart.items.filter(it =>
      !(String(it.productId) === String(productId) &&
        String(it.variantId) === String(variantId))
    );

    cart.calculateTotal();
    await cart.save();

    const populatedcart = await findCartForStorefront(userId, storefront)
      .populate({ 
        path: 'items.productId', 
        select: CART_PRODUCT_SELECT
      });

    const formattedItems = [];
    if (populatedcart) {
      for (const it of populatedcart.items) {
        const prod = it.productId;
        if (!prod) continue;
        let varObj = prod.variants?.find(v => String(v._id) === String(it.variantId));
        if (!varObj) varObj = firstListedVariant(prod, storefront);
        if (!varObj) continue;
        const formatted = formatcartItem(it, prod, varObj, storefront);
        if (formatted) formattedItems.push(formatted);
      }
    }

    const totalAmt = formattedItems.reduce((sum, it) => sum + it.total, 0);
    const totalOriginalAmt = formattedItems.reduce((sum, it) => sum + (it.price.base * it.quantity), 0);
    const totalDisc = totalOriginalAmt - totalAmt;
    const totalDiscPerc = totalOriginalAmt > 0 ? Math.round((totalDisc / totalOriginalAmt) * 100) : 0;

    res.json({ 
      success: true, 
      cart: populatedcart ? {
        ...populatedcart.toObject(),
        items: formattedItems,
        totalAmount: totalAmt,
        totalOriginalAmount: totalOriginalAmt,
        totalDiscount: totalDisc,
        totalDiscountPercentage: totalDiscPerc
      } : { items: [], totalAmount: 0 },
      userType,
      storefront
    });
    
  } catch (err) {
    console.error('removecartItem:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// =============================================
// BULK REMOVE FROM CART
// =============================================
const bulkRemove = async (req, res) => {
  const userId = req.userId;
  const userType = req.userType || 'user';
  const storefront = storefrontOrDefault(req);
  const { items } = req.body;

  try {
    const cart = await findCartForStorefront(userId, storefront);
    if (!cart) {
      return res.status(404).json({ 
        success: false, 
        message: 'cart not found' 
      });
    }

    cart.items = cart.items.filter(it =>
      !items.some(rem =>
        String(rem.productId) === String(it.productId) &&
        String(rem.variantId) === String(it.variantId)
      )
    );

    cart.calculateTotal();
    await cart.save();

    const populatedcart = await findCartForStorefront(userId, storefront)
      .populate({ 
        path: 'items.productId', 
        select: CART_PRODUCT_SELECT
      });

    const formattedItems = [];
    if (populatedcart) {
      for (const it of populatedcart.items) {
        const prod = it.productId;
        if (!prod) continue;
        let varObj = prod.variants?.find(v => String(v._id) === String(it.variantId));
        if (!varObj) varObj = firstListedVariant(prod, storefront);
        if (!varObj) continue;
        const formatted = formatcartItem(it, prod, varObj, storefront);
        if (formatted) formattedItems.push(formatted);
      }
    }

    const totalAmt = formattedItems.reduce((sum, it) => sum + it.total, 0);
    const totalOriginalAmt = formattedItems.reduce((sum, it) => sum + (it.price.base * it.quantity), 0);
    const totalDisc = totalOriginalAmt - totalAmt;
    const totalDiscPerc = totalOriginalAmt > 0 ? Math.round((totalDisc / totalOriginalAmt) * 100) : 0;

    res.json({ 
      success: true, 
      cart: populatedcart ? {
        ...populatedcart.toObject(),
        items: formattedItems,
        totalAmount: totalAmt,
        totalOriginalAmount: totalOriginalAmt,
        totalDiscount: totalDisc,
        totalDiscountPercentage: totalDiscPerc
      } : { items: [], totalAmount: 0 },
      userType,
      storefront
    });
    
  } catch (err) {
    console.error('bulkRemove:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// =============================================
// CLEAR CART
// =============================================
const clearcart = async (req, res) => {
  const userId = req.userId;
  const userType = req.userType || 'user';
  const storefront = storefrontOrDefault(req);

  try {
    const cart = await findCartForStorefront(userId, storefront);
    if (!cart) {
      return res.json({ 
        success: true, 
        message: 'cart already empty',
        cart: { items: [], totalAmount: 0 },
        userType,
        storefront
      });
    }

    cart.items = [];
    cart.totalAmount = 0;
    cart.deliverySnapshot = undefined;
    await cart.save();

    return res.json({
      success: true,
      message: 'cart cleared successfully',
      cart: { items: [], totalAmount: 0 },
      userType,
      storefront
    });

  } catch (err) {
    console.error('clearcart:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

module.exports = {
  addToCart: addTocart,
  updateCartItem: updatecartItem,
  mergeCart: mergecart,
  getCart: getcart,
  removeCartItem: removecartItem,
  bulkRemove,
  clearCart: clearcart
};