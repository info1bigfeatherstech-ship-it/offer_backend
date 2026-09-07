// controllers/admin-analytics.controller.js
const User = require('../models/User');
const Cart = require('../models/cart');
const Wishlist = require('../models/Wishlist');
const Product = require('../models/Product');
const mongoose = require('mongoose');
const {
  sendBulkCartReminderEmails,
  MAX_BULK_RECIPIENTS
} = require('../services/cartReminderEmail.service');
const {
  sendBulkCartReminderPushes,
  MAX_BULK_RECIPIENTS: MAX_BULK_PUSH_RECIPIENTS
} = require('../services/cartReminderPush.service');
const {
  sendBulkWishlistReminderPushes,
  MAX_BULK_RECIPIENTS: MAX_BULK_WISHLIST_PUSH_RECIPIENTS
} = require('../services/wishlistReminderPush.service');
const leadsPushSettingsService = require('../services/leadsPushSettings.service');
const engagementAnalyticsService = require('../services/engagementAnalytics.service');

const scopedUserQueryFromReq = (req) => req.adminScope?.userMatch || { userType: 'user' };
const scopeLabelFromReq = (req) => req.adminScope?.storefront || 'ecomm';

function mergeAnd(base, extra) {
  if (!extra || !Object.keys(extra).length) return base;
  if (!base || !Object.keys(base).length) return extra;
  return { $and: [base, extra] };
}

const {
  mergeCustomerStorefrontFilter,
  resolveCustomerStorefrontFromReq
} = require('../utils/customerStorefrontScope');
const { findCartForStorefront } = require('../services/cartStorefront.service');

async function fetchScopedUserIds(req) {
  const scopedUsers = await User.find(scopedUserQueryFromReq(req)).select('_id').lean();
  return scopedUsers.map((u) => u._id);
}

function scopedCartQueryFromReq(req, extra = {}) {
  const storefront = resolveCustomerStorefrontFromReq(req);
  return mergeCustomerStorefrontFilter(extra, storefront);
}

const ADMIN_CART_PRODUCT_SELECT = 'name title slug variants';
const ADMIN_CART_POPULATE = [
  { path: 'userId', select: 'name email phone role' },
  {
    path: 'items.productId',
    select: ADMIN_CART_PRODUCT_SELECT
  }
];

function getItemUnitPrice(priceSnapshot) {
  if (!priceSnapshot) return 0;
  return priceSnapshot.sale ?? priceSnapshot.base ?? 0;
}

function formatAdminCartItem(item) {
  const product = item.productId;
  const variant = product?.variants?.find(
    (v) => String(v._id) === String(item.variantId)
  );

  const unitPrice = getItemUnitPrice(item.priceSnapshot);
  const quantity = item.quantity || 1;

  return {
    productId: product?._id,
    productName: product?.name || product?.title || 'Unknown Product',
    productSlug: product?.slug,
    variantId: item.variantId,
    sku: variant?.sku || null,
    productCode: variant?.productCode ?? null,
    quantity,
    unitPrice,
    lineTotal: unitPrice * quantity,
    priceSnapshot: item.priceSnapshot,
    variantAttributes: item.variantAttributesSnapshot?.length
      ? item.variantAttributesSnapshot
      : variant?.attributes || [],
    imageUrl: variant?.images?.[0]?.url || null,
    addedAt: item.createdAt
  };
}

function formatAdminCart(cart, extra = {}) {
  const items = (cart.items || []).map(formatAdminCartItem);

  return {
    _id: cart._id,
    user: cart.userId,
    items,
    totalAmount: cart.totalAmount ?? 0,
    itemCount: items.length,
    createdAt: cart.createdAt,
    updatedAt: cart.updatedAt,
    ...extra
  };
}

// =============================================
// 1. GET ALL USERS (READ ONLY)
// =============================================
const getAllUsers = async (req, res) => {
  try {
    let { page = 1, limit = 20, search = '', role = '' } = req.query;

    page = Math.max(1, Number(page));
    limit = Math.min(100, Math.max(1, Number(limit)));
    const skip = (page - 1) * limit;

    // Build query (always scoped by admin storefront)
    let query = scopedUserQueryFromReq(req);
    
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } }
      ];
    }
    
    if (role && ['user', 'wholesaler', 'admin'].includes(role)) {
      query = mergeAnd(query, { role });
    }

    const [users, total] = await Promise.all([
      User.find(query)
        .select('-password -refreshToken') // Exclude sensitive data
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(query)
    ]);

    // Get additional stats for each user
    const usersWithStats = await Promise.all(users.map(async (user) => {
      // Get cart count
      const cartt = await findCartForStorefront(user._id, resolveCustomerStorefrontFromReq(req));
      const cartItemsCount = cartt?.items?.length || 0;
      
      // Get wishlist count
      const wishlist = await Wishlist.findOne({ userId: user._id });
      const wishlistCount = wishlist?.products?.length || 0;
      
      return {
        ...user,
        cartItemsCount,
        wishlistCount,
        lastActive: user.updatedAt || user.createdAt
      };
    }));

    return res.status(200).json({
      success: true,
      scope: scopeLabelFromReq(req),
      data: usersWithStats,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error('Get all users error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error fetching users',
      error: error.message
    });
  }
};

/**
 * Export all customer/wholesaler users to Excel (Leads → Customers).
 * Excludes admin/staff accounts and secrets (password, tokens, OTPs).
 * GET /api/admin/analytics/users/export
 */
const exportUsersExcel = async (req, res) => {
  try {
    const XLSX = require('xlsx');

    const users = await User.find(
      mergeAnd(scopedUserQueryFromReq(req), {
        role: {
          $nin: ['admin', 'product_manager', 'order_manager', 'marketing_manager', 'inventory_manager']
        }
      })
    )
      .select(
        'name email phone userType role status isEmailVerified isPhoneVerified registrationMethod isProfileComplete lastLoginMethod createdAt updatedAt'
      )
      .sort({ createdAt: -1 })
      .lean();

    if (!users.length) {
      return res.status(200).json({
        success: true,
        message: 'No customers found to export.'
      });
    }

    const HEADERS = [
      'Name',
      'Email',
      'Phone',
      'User Type',
      'Role',
      'Status',
      'Email Verified',
      'Phone Verified',
      'Registration Method',
      'Profile Complete',
      'Last Login Method',
      'Created At',
      'Updated At'
    ];

    const toYesNo = (v) => (v ? 'Yes' : 'No');
    const toIso = (v) => {
      if (!v) return '';
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? '' : d.toISOString();
    };

    const dataRows = users.map((u) => [
      u.name || '',
      u.email || '',
      u.phone || '',
      u.userType || '',
      u.role || '',
      u.status || '',
      toYesNo(u.isEmailVerified),
      toYesNo(u.isPhoneVerified),
      u.registrationMethod || '',
      toYesNo(u.isProfileComplete),
      u.lastLoginMethod || '',
      toIso(u.createdAt),
      toIso(u.updatedAt)
    ]);

    const wb = XLSX.utils.book_new();
    const sheetData = [HEADERS, ...dataRows];
    const ws = XLSX.utils.aoa_to_sheet(sheetData);

    const colWidths = HEADERS.map((h, ci) => {
      let max = h.length;
      for (let ri = 1; ri < Math.min(sheetData.length, 200); ri++) {
        const val = sheetData[ri][ci];
        if (val != null) max = Math.max(max, String(val).length);
      }
      return { wch: Math.min(max + 2, 48) };
    });
    ws['!cols'] = colWidths;
    ws['!freeze'] = { xSplit: 0, ySplit: 1, topLeftCell: 'A2', activePane: 'bottomLeft' };

    XLSX.utils.book_append_sheet(wb, ws, 'Customers');

    const xlsxBuffer = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
    const today = new Date().toISOString().slice(0, 10);
    const filename = `customers_export_${today}.xlsx`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', xlsxBuffer.length);
    return res.send(xlsxBuffer);
  } catch (error) {
    console.error('Export users error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error exporting customers',
      error: error.message
    });
  }
};

// =============================================
// 2. GET USER DETAILS BY ID (READ ONLY)
// =============================================
const           getUserById = async (req, res) => {
  try {
    const { userId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid user ID'
      });
    }

    const user = await User.findOne(mergeAnd({ _id: userId }, scopedUserQueryFromReq(req)))
      .select('-password -refreshToken')
      .lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const userCart = await findCartForStorefront(user._id, resolveCustomerStorefrontFromReq(req))
      .populate(ADMIN_CART_POPULATE)
      .lean();

    // Get wishlist details
    const wishlist = await Wishlist.findOne({ userId: user._id })
      .populate('products.productId', 'name slug price variants')
      .lean();

    return res.status(200).json({
      success: true,
      scope: scopeLabelFromReq(req),
      data: {
        user,
        cart: userCart ? formatAdminCart(userCart) : { items: [], totalAmount: 0, itemCount: 0 },
        wishlist: wishlist || { products: [] }
      }
    });

  } catch (error) {
    console.error('Get user by ID error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error fetching user details',
      error: error.message
    });
  }
};


// =============================================
// 3. GET ALL CARTS WITH ANALYTICS
// =============================================
const getAllcarts = async (req, res) => {
  try {
    let { page = 1, limit = 20, sortBy = 'createdAt', order = 'desc' } = req.query;

    page = Math.max(1, Number(page));
    limit = Math.min(100, Math.max(1, Number(limit)));
    const skip = (page - 1) * limit;

    const sortOrder = order === 'asc' ? 1 : -1;
    const sort = { [sortBy]: sortOrder };

    const scopedUserIds = await fetchScopedUserIds(req);
    if (!scopedUserIds.length) {
      return res.status(200).json({
        success: true,
        scope: scopeLabelFromReq(req),
        data: [],
        pagination: { total: 0, page, limit, totalPages: 0 }
      });
    }

    const scopeQuery = scopedCartQueryFromReq(req, { userId: { $in: scopedUserIds } });

    const [carts, total] = await Promise.all([
      Cart.find(scopeQuery)
        .populate(ADMIN_CART_POPULATE)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean(),
      Cart.countDocuments(scopeQuery)
    ]);

    const formattedcarts = carts.map((cart) => formatAdminCart(cart));

    return res.status(200).json({
      success: true,
      scope: scopeLabelFromReq(req),
      data: formattedcarts,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error('Get all carts error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error fetching carts',
      error: error.message
    });
  }
};

// =============================================
// 4. GET ABANDONED CARTS (Not purchased, older than X hours)
// =============================================
const getAbandonedcarts = async (req, res) => {
  try {
    let { page = 1, limit = 20, hours = 24 } = req.query;

    page = Math.max(1, Number(page));
    limit = Math.min(100, Math.max(1, Number(limit)));
    hours = Math.max(1, Number(hours));
    const skip = (page - 1) * limit;

    const cutoffDate = new Date();
    cutoffDate.setHours(cutoffDate.getHours() - hours);

    const scopedUserIds = await fetchScopedUserIds(req);
    if (!scopedUserIds.length) {
      return res.status(200).json({
        success: true,
        scope: scopeLabelFromReq(req),
        data: [],
        pagination: {
          total: 0,
          page,
          limit,
          totalPages: 0,
          criteria: `Abandoned for > ${hours} hours`
        }
      });
    }

    const scopeQuery = scopedCartQueryFromReq(req, { userId: { $in: scopedUserIds } });

    // Find carts older than cutoff date with items
    const carts = await Cart.find({
      ...scopeQuery,
      updatedAt: { $lt: cutoffDate },
      'items.0': { $exists: true } // Has at least one item
    })
      .populate(ADMIN_CART_POPULATE)
      .sort({ updatedAt: 1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const total = await Cart.countDocuments({
      ...scopeQuery,
      updatedAt: { $lt: cutoffDate },
      'items.0': { $exists: true }
    });

    const formattedcarts = carts.map((cart) =>
      formatAdminCart(cart, {
        abandonedSince: cart.updatedAt,
        hoursSinceUpdate: Math.floor(
          (Date.now() - new Date(cart.updatedAt)) / (1000 * 60 * 60)
        )
      })
    );

    return res.status(200).json({
      success: true,
      scope: scopeLabelFromReq(req),
      data: formattedcarts,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        criteria: `Abandoned for > ${hours} hours`
      }
    });

  } catch (error) {
    console.error('Get abandoned carts error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error fetching abandoned carts',
      error: error.message
    });
  }
};

// =============================================
// 5. GET CARTS WITH HIGH VALUE (Above threshold)
// =============================================
const getHighValuecarts = async (req, res) => {
  try {
    let { page = 1, limit = 20, minAmount = 5000 } = req.query;

    page = Math.max(1, Number(page));
    limit = Math.min(100, Math.max(1, Number(limit)));
    minAmount = Math.max(0, Number(minAmount));
    const skip = (page - 1) * limit;

    const scopedUserIds = await fetchScopedUserIds(req);
    if (!scopedUserIds.length) {
      return res.status(200).json({
        success: true,
        scope: scopeLabelFromReq(req),
        data: [],
        pagination: {
          total: 0,
          page,
          limit,
          totalPages: 0,
          criteria: `cart value ≥ ₹${minAmount}`
        }
      });
    }

    const scopeQuery = scopedCartQueryFromReq(req, { userId: { $in: scopedUserIds } });

    const carts = await Cart.find({
      ...scopeQuery,
      totalAmount: { $gte: minAmount },
      'items.0': { $exists: true }
    })
      .populate(ADMIN_CART_POPULATE)
      .sort({ totalAmount: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const total = await Cart.countDocuments({
      ...scopeQuery,
      totalAmount: { $gte: minAmount },
      'items.0': { $exists: true }
    });

    return res.status(200).json({
      success: true,
      scope: scopeLabelFromReq(req),
      data: carts.map((cart) => formatAdminCart(cart)),
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        criteria: `cart value ≥ ₹${minAmount}`
      }
    });

  } catch (error) {
    console.error('Get high value carts error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error fetching high value carts',
      error: error.message
    });
  }
};

// =============================================
// 5b. GET SINGLE CART BY ID (READ ONLY)
// =============================================
const getCartById = async (req, res) => {
  try {
    const { cartId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(cartId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid cart ID'
      });
    }

    const scopedUserIds = await fetchScopedUserIds(req);
    if (!scopedUserIds.length) {
      return res.status(404).json({
        success: false,
        message: 'Cart not found'
      });
    }

    const cart = await Cart.findOne(
      scopedCartQueryFromReq(req, {
        _id: cartId,
        userId: { $in: scopedUserIds }
      })
    )
      .populate(ADMIN_CART_POPULATE)
      .lean();

    if (!cart) {
      return res.status(404).json({
        success: false,
        message: 'Cart not found'
      });
    }

    return res.status(200).json({
      success: true,
      scope: scopeLabelFromReq(req),
      data: formatAdminCart(cart)
    });
  } catch (error) {
    console.error('Get cart by ID error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error fetching cart details',
      error: error.message
    });
  }
};

// =============================================
// 6. GET ALL WISHLISTS
// =============================================
const getAllWishlists = async (req, res) => {
  try {
    let { page = 1, limit = 20, sortBy = 'createdAt', order = 'desc' } = req.query;

    page = Math.max(1, Number(page));
    limit = Math.min(100, Math.max(1, Number(limit)));
    const skip = (page - 1) * limit;

    const sortOrder = order === 'asc' ? 1 : -1;
    const sort = { [sortBy]: sortOrder };

    const scopedUserIds = await fetchScopedUserIds(req);
    if (!scopedUserIds.length) {
      return res.status(200).json({
        success: true,
        scope: scopeLabelFromReq(req),
        data: [],
        pagination: { total: 0, page, limit, totalPages: 0 }
      });
    }
    const scopeQuery = { userId: { $in: scopedUserIds } };

    const [wishlists, total] = await Promise.all([
      Wishlist.find(scopeQuery)
        .populate('userId', 'name email phone role')
        .populate('products.productId', 'name slug images price')
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean(),
      Wishlist.countDocuments(scopeQuery)
    ]);

    const formattedWishlists = wishlists.map(wishlist => ({
      _id: wishlist._id,
      user: wishlist.userId,
      products: wishlist.products.map(p => ({
        productId: p.productId?._id,
        productName: p.productId?.name,
        variantId: p.variantId,
        addedAt: p.addedAt,
        price: p.productId?.price?.sale || p.productId?.price?.base
      })),
      createdAt: wishlist.createdAt,
      updatedAt: wishlist.updatedAt,
      itemCount: wishlist.products.length
    }));

    return res.status(200).json({
      success: true,
      scope: scopeLabelFromReq(req),
      data: formattedWishlists,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error('Get all wishlists error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error fetching wishlists',
      error: error.message
    });
  }
};

// =============================================
// 7. GET STALE WISHLISTS (Items added X days ago, not purchased)
// =============================================
const getStaleWishlists = async (req, res) => {
  try {
    let { page = 1, limit = 20, days = 7 } = req.query;

    page = Math.max(1, Number(page));
    limit = Math.min(100, Math.max(1, Number(limit)));
    days = Math.max(1, Number(days));
    const skip = (page - 1) * limit;

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    const scopedUserIds = await fetchScopedUserIds(req);
    if (!scopedUserIds.length) {
      return res.status(200).json({
        success: true,
        scope: scopeLabelFromReq(req),
        data: [],
        pagination: {
          total: 0,
          page,
          limit,
          totalPages: 0,
          criteria: `Items added > ${days} days ago`
        }
      });
    }
    const scopeQuery = { userId: { $in: scopedUserIds } };

    // Find wishlists with products added before cutoff date
    const wishlists = await Wishlist.find({
      ...scopeQuery,
      'products.addedAt': { $lt: cutoffDate },
      'products.0': { $exists: true }
    })
      .populate('userId', 'name email phone')
      .populate('products.productId', 'name slug price')
      .sort({ 'products.addedAt': 1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const total = await Wishlist.countDocuments({
      ...scopeQuery,
      'products.addedAt': { $lt: cutoffDate },
      'products.0': { $exists: true }
    });

    const formattedWishlists = wishlists.map(wishlist => {
      // Get oldest product in wishlist
      const oldestProduct = wishlist.products.reduce((oldest, p) => 
        p.addedAt < oldest.addedAt ? p : oldest, wishlist.products[0]);
      
      return {
        _id: wishlist._id,
        user: wishlist.userId,
        products: wishlist.products.map(p => ({
          productId: p.productId?._id,
          productName: p.productId?.name,
          variantId: p.variantId,
          addedAt: p.addedAt,
          daysSinceAdded: Math.floor((Date.now() - new Date(p.addedAt)) / (1000 * 60 * 60 * 24))
        })),
        oldestItemAddedAt: oldestProduct.addedAt,
        daysSinceOldestItem: Math.floor((Date.now() - new Date(oldestProduct.addedAt)) / (1000 * 60 * 60 * 24)),
        itemCount: wishlist.products.length,
        createdAt: wishlist.createdAt
      };
    });

    return res.status(200).json({
      success: true,
      scope: scopeLabelFromReq(req),
      data: formattedWishlists,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        criteria: `Items added > ${days} days ago`
      }
    });

  } catch (error) {
    console.error('Get stale wishlists error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error fetching stale wishlists',
      error: error.message
    });
  }
};

// =============================================
// 8. GET WISHLISTS WITH MOST POPULAR PRODUCTS
// =============================================
const getPopularWishlistProducts = async (req, res) => {
  try {
    let { limit = 20 } = req.query;
    limit = Math.min(50, Math.max(1, Number(limit)));

    const scopedUserIds = await fetchScopedUserIds(req);
    if (!scopedUserIds.length) {
      return res.status(200).json({
        success: true,
        scope: scopeLabelFromReq(req),
        data: [],
        totalProducts: 0
      });
    }

    const wishlists = await Wishlist.find({
      userId: { $in: scopedUserIds },
      'products.0': { $exists: true }
    })
      .populate('products.productId', 'name slug price images')
      .lean();

    // Count product popularity
    const productCount = {};
    
    for (const wishlist of wishlists) {
      for (const product of wishlist.products) {
        const productId = product.productId?._id?.toString();
        if (productId) {
          productCount[productId] = (productCount[productId] || 0) + 1;
        }
      }
    }

    // Sort and format
    const popularProducts = Object.entries(productCount)
      .map(([productId, count]) => {
        const product = wishlists.find(w => 
          w.products.some(p => p.productId?._id?.toString() === productId)
        )?.products.find(p => p.productId?._id?.toString() === productId)?.productId;
        
        return {
          productId,
          productName: product?.name,
          wishlistCount: count,
          price: product?.price?.sale || product?.price?.base
        };
      })
      .sort((a, b) => b.wishlistCount - a.wishlistCount)
      .slice(0, limit);

    return res.status(200).json({
      success: true,
      scope: scopeLabelFromReq(req),
      data: popularProducts,
      totalProducts: Object.keys(productCount).length
    });

  } catch (error) {
    console.error('Get popular wishlist products error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error fetching popular products',
      error: error.message
    });
  }
};

// =============================================
// 9. DASHBOARD SUMMARY (Admin Dashboard)
// =============================================
const getDashboardSummary = async (req, res) => {
  try {
    const scopedUserQuery = scopedUserQueryFromReq(req);
    const scopedUserIds = await fetchScopedUserIds(req);
    const hasScopedUsers = scopedUserIds.length > 0;

    // Get counts
    const [
      totalUsers,
      totalWholesalers,
      totalcarts,
      totalWishlists,
      abandonedcarts24h,
      staleWishlists7d
    ] = await Promise.all([
      User.countDocuments(scopedUserQuery),
      User.countDocuments(mergeAnd(scopedUserQuery, { role: 'wholesaler' })),
      hasScopedUsers ? Cart.countDocuments({ userId: { $in: scopedUserIds }, 'items.0': { $exists: true } }) : 0,
      hasScopedUsers ? Wishlist.countDocuments({ userId: { $in: scopedUserIds }, 'products.0': { $exists: true } }) : 0,
      
      // Abandoned carts (>24 hours)
      hasScopedUsers ? Cart.countDocuments({
        userId: { $in: scopedUserIds },
        updatedAt: { $lt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        'items.0': { $exists: true }
      }) : 0,
      
      // Stale wishlists (>7 days)
      hasScopedUsers ? Wishlist.countDocuments({
        userId: { $in: scopedUserIds },
        'products.addedAt': { $lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
        'products.0': { $exists: true }
      }) : 0
    ]);

    // Get total cart value
    const cartAggregation = hasScopedUsers ? await Cart.aggregate([
      { $match: { userId: { $in: scopedUserIds }, 'items.0': { $exists: true } } },
      { $group: { _id: null, totalValue: { $sum: '$totalAmount' } } }
    ]) : [];
    const totalcartValue = cartAggregation[0]?.totalValue || 0;

    // Get average cart value
    const avgcartValue = totalcarts > 0 ? totalcartValue / totalcarts : 0;

    return res.status(200).json({
      success: true,
      scope: scopeLabelFromReq(req),
      data: {
        users: {
          total: totalUsers,
          wholesalers: totalWholesalers,
          regular: totalUsers - totalWholesalers
        },
        carts: {
          total: totalcarts,
          totalValue: totalcartValue,
          averageValue: avgcartValue,
          abandoned24h: abandonedcarts24h
        },
        wishlists: {
          total: totalWishlists,
          stale7d: staleWishlists7d
        },
        timestamp: new Date()
      }
    });

  } catch (error) {
    console.error('Get dashboard summary error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error fetching dashboard summary',
      error: error.message
    });
  }
};

// =============================================
// LEADS PUSH SETTINGS (auto daily toggle)
// =============================================
const getLeadsPushSettings = async (req, res) => {
  try {
    const storefront = scopeLabelFromReq(req);
    const data = await leadsPushSettingsService.getAdminSettings(storefront);
    return res.status(200).json({
      success: true,
      scope: storefront,
      data,
    });
  } catch (error) {
    console.error('Get leads push settings error:', error);
    return res.status(500).json({
      success: false,
      message: 'Could not load push notification settings',
    });
  }
};

const updateLeadsPushSettings = async (req, res) => {
  try {
    const body = req.body || {};
    const hasAnyFlag =
      body.autoPushEnabled !== undefined ||
      body.newProductsAutoPushEnabled !== undefined ||
      body.wishlistAutoPushEnabled !== undefined;

    if (!hasAnyFlag) {
      return res.status(400).json({
        success: false,
        code: 'PUSH_SETTINGS_PATCH_REQUIRED',
        message:
          'Provide at least one of: autoPushEnabled, newProductsAutoPushEnabled, wishlistAutoPushEnabled',
      });
    }

    const storefront = scopeLabelFromReq(req);
    const data = await leadsPushSettingsService.updatePushSettings(
      storefront,
      {
        autoPushEnabled: body.autoPushEnabled,
        newProductsAutoPushEnabled: body.newProductsAutoPushEnabled,
        wishlistAutoPushEnabled: body.wishlistAutoPushEnabled,
      },
      req.user?._id || req.userId || null
    );

    return res.status(200).json({
      success: true,
      scope: storefront,
      message: 'Push notification settings updated',
      data,
    });
  } catch (error) {
    console.error('Update leads push settings error:', error);
    const code = error.code || 'PUSH_SETTINGS_UPDATE_FAILED';
    const status = code === 'PUSH_SETTINGS_PATCH_REQUIRED' ? 400 : 500;
    return res.status(status).json({
      success: false,
      code,
      message: error.message || 'Could not update push notification settings',
    });
  }
};

// =============================================
// BULK CART REMINDER PUSH
// =============================================
const bulkCartReminderPush = async (req, res) => {
  try {
    const userIds = req.body?.userIds;
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({
        success: false,
        code: 'USER_IDS_REQUIRED',
        message: 'userIds array is required'
      });
    }
    if (userIds.length > MAX_BULK_PUSH_RECIPIENTS) {
      return res.status(400).json({
        success: false,
        code: 'BULK_LIMIT_EXCEEDED',
        message: `Maximum ${MAX_BULK_PUSH_RECIPIENTS} users per bulk send`
      });
    }

    const results = await sendBulkCartReminderPushes({
      userIds,
      scopeQuery: scopedUserQueryFromReq(req),
      storefront: resolveCustomerStorefrontFromReq(req)
    });

    return res.status(200).json({
      success: true,
      message: `Cart reminder push processed: ${results.sent} sent, ${results.skipped} skipped, ${results.failed} failed`,
      ...results
    });
  } catch (error) {
    console.error('Bulk cart reminder push error:', error);
    const code = error.code || 'CART_REMINDER_PUSH_FAILED';
    const status =
      code === 'PUSH_NOT_CONFIGURED'
        ? 503
        : ['USER_IDS_REQUIRED', 'BULK_LIMIT_EXCEEDED', 'INVALID_USER_IDS'].includes(code)
          ? 400
          : 500;
    return res.status(status).json({
      success: false,
      code,
      message: error.message || 'Could not send cart reminder push notifications'
    });
  }
};

// =============================================
// BULK WISHLIST REMINDER PUSH
// =============================================
const bulkWishlistReminderPush = async (req, res) => {
  try {
    const userIds = req.body?.userIds;
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({
        success: false,
        code: 'USER_IDS_REQUIRED',
        message: 'userIds array is required'
      });
    }
    if (userIds.length > MAX_BULK_WISHLIST_PUSH_RECIPIENTS) {
      return res.status(400).json({
        success: false,
        code: 'BULK_LIMIT_EXCEEDED',
        message: `Maximum ${MAX_BULK_WISHLIST_PUSH_RECIPIENTS} users per bulk send`
      });
    }

    const results = await sendBulkWishlistReminderPushes({
      userIds,
      scopeQuery: scopedUserQueryFromReq(req),
      storefront: resolveCustomerStorefrontFromReq(req)
    });

    return res.status(200).json({
      success: true,
      message: `Wishlist reminder push processed: ${results.sent} sent, ${results.skipped} skipped, ${results.failed} failed`,
      ...results
    });
  } catch (error) {
    console.error('Bulk wishlist reminder push error:', error);
    const code = error.code || 'WISHLIST_REMINDER_PUSH_FAILED';
    const status =
      code === 'PUSH_NOT_CONFIGURED'
        ? 503
        : ['USER_IDS_REQUIRED', 'BULK_LIMIT_EXCEEDED', 'INVALID_USER_IDS'].includes(code)
          ? 400
          : 500;
    return res.status(status).json({
      success: false,
      code,
      message: error.message || 'Could not send wishlist reminder push notifications'
    });
  }
};

// =============================================
// BULK CART REMINDER EMAIL
// =============================================
const bulkCartReminderEmail = async (req, res) => {
  try {
    const userIds = req.body?.userIds;
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({
        success: false,
        code: 'USER_IDS_REQUIRED',
        message: 'userIds array is required'
      });
    }
    if (userIds.length > MAX_BULK_RECIPIENTS) {
      return res.status(400).json({
        success: false,
        code: 'BULK_LIMIT_EXCEEDED',
        message: `Maximum ${MAX_BULK_RECIPIENTS} users per bulk send`
      });
    }

    const results = await sendBulkCartReminderEmails({
      userIds,
      scopeQuery: scopedUserQueryFromReq(req),
      storefront: resolveCustomerStorefrontFromReq(req)
    });

    return res.status(200).json({
      success: true,
      message: `Cart reminder emails processed: ${results.sent} sent, ${results.skipped} skipped, ${results.failed} failed`,
      ...results
    });
  } catch (error) {
    console.error('Bulk cart reminder email error:', error);
    const code = error.code || 'CART_REMINDER_EMAIL_FAILED';
    const status =
      code === 'EMAIL_NOT_CONFIGURED'
        ? 503
        : ['USER_IDS_REQUIRED', 'BULK_LIMIT_EXCEEDED', 'INVALID_USER_IDS'].includes(code)
          ? 400
          : 500;
    return res.status(status).json({
      success: false,
      code,
      message: error.message || 'Could not send cart reminder emails'
    });
  }
};


const getEngagementSummary = async (req, res) => {
  try {
    const summary = await engagementAnalyticsService.getEngagementSummary(
      scopedUserQueryFromReq(req)
    );
    return res.status(200).json({
      success: true,
      scope: scopeLabelFromReq(req),
      data: summary,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Could not load engagement summary',
    });
  }
};

const getPushSubscribers = async (req, res) => {
  try {
    const result = await engagementAnalyticsService.listPushSubscribers(
      scopedUserQueryFromReq(req),
      req.query
    );
    return res.status(200).json({
      success: true,
      scope: scopeLabelFromReq(req),
      ...result,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Could not load push subscribers',
    });
  }
};

const getPwaInstalls = async (req, res) => {
  try {
    const result = await engagementAnalyticsService.listPwaInstalls(
      scopedUserQueryFromReq(req),
      req.query
    );
    return res.status(200).json({
      success: true,
      scope: scopeLabelFromReq(req),
      ...result,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Could not load PWA installs',
    });
  }
};

module.exports = {
  getAllUsers,
  exportUsersExcel,
  getUserById,
  getLeadsPushSettings,
  updateLeadsPushSettings,
  bulkCartReminderPush,
  bulkWishlistReminderPush,
  bulkCartReminderEmail,
  getAllCarts: getAllcarts,
  getAbandonedCarts: getAbandonedcarts,
  getHighValueCarts: getHighValuecarts,
  getCartById,
  getAllWishlists,
  getStaleWishlists,
  getPopularWishlistProducts,
  getDashboardSummary,
  getEngagementSummary,
  getPushSubscribers,
  getPwaInstalls
};