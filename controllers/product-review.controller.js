const mongoose = require('mongoose');
const Product = require('../models/Product');
const ProductReview = require('../models/ProductReview');
const {
  syncProductRatingFromReviews,
  aggregateActiveReviewSummary
} = require('../services/productReviewSync.service');
const {
  findDeliveredPurchaseForProduct,
  getProductReviewEligibility,
  getOrderReviewableItems
} = require('../services/reviewEligibility.service');
const {
  MAX_REVIEW_IMAGES,
  uploadReviewImages,
  deleteReviewImagesFromCloudinary,
  normalizeStoredImages,
  parseRemoveImagePublicIds
} = require('../services/reviewImageUpload.service');
const {
  resolveReviewStorefrontFromReq,
  mergeReviewStorefrontFilter,
  normalizeReviewStorefront
} = require('../utils/reviewStorefrontScope');

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(String(id));

function jsonError(res, status, code, message, details) {
  return res.status(status).json({
    success: false,
    code,
    message,
    ...(details ? { details } : {})
  });
}

function mapPublicImages(images) {
  return normalizeStoredImages(images);
}

function serializeCustomerReview(review) {
  if (!review) return null;
  return {
    _id: review._id,
    rating: review.rating,
    comment: review.comment || '',
    isActive: review.isActive,
    verifiedPurchase: Boolean(review.verifiedPurchase),
    orderId: review.orderId || null,
    storefront: normalizeReviewStorefront(review.storefront),
    images: mapPublicImages(review.images),
    createdAt: review.createdAt,
    updatedAt: review.updatedAt
  };
}

function parseReviewRequestBody(req) {
  const body = req.body || {};
  return {
    productId: body.productId,
    rating: body.rating,
    comment: body.comment,
    orderId: body.orderId,
    variantId: body.variantId,
    removeImagePublicIds: parseRemoveImagePublicIds(body.removeImagePublicIds)
  };
}

function getIncomingReviewImageFiles(req) {
  const fromFields = req.files?.reviewImages;
  if (Array.isArray(fromFields) && fromFields.length) return fromFields;
  if (req.file?.buffer) return [req.file];
  return [];
}

function publicAuthorLabel(doc) {
  if (doc.source === 'admin') {
    const n = String(doc.displayName || '').trim();
    return n || 'Customer';
  }
  const raw = String(doc.userId?.name || '').trim();
  if (!raw) return 'Verified buyer';
  const first = raw.split(/\s+/)[0];
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

function resolveVariantIdFromOrder(order, productId, preferredVariantId) {
  const pid = String(productId);
  const items = Array.isArray(order?.items) ? order.items : [];
  const matching = items.filter((it) => String(it.productId) === pid);
  if (!matching.length) return null;

  if (preferredVariantId && isValidObjectId(preferredVariantId)) {
    const pref = String(preferredVariantId);
    const hit = matching.find((it) => it.variantId && String(it.variantId) === pref);
    if (hit?.variantId) return hit.variantId;
  }

  return matching.find((it) => it.variantId)?.variantId || null;
}

// ─── Public ───────────────────────────────────────────────────────────────

const getPublicSummary = async (req, res) => {
  try {
    const { productId } = req.params;
    if (!isValidObjectId(productId)) {
      return jsonError(res, 400, 'INVALID_PRODUCT_ID', 'Invalid product id');
    }

    const product = await Product.findById(productId).select('_id').lean();
    if (!product) {
      return jsonError(res, 404, 'PRODUCT_NOT_FOUND', 'Product not found');
    }

    const storefront = resolveReviewStorefrontFromReq(req);
    const summary = await aggregateActiveReviewSummary(productId, storefront);

    return res.json({
      success: true,
      scope: storefront,
      summary: {
        averageRating: summary.averageRating,
        reviewCount: summary.reviewCount
      }
    });
  } catch (err) {
    console.error('[getPublicSummary]', err);
    return jsonError(res, 500, 'REVIEW_SUMMARY_ERROR', 'Could not load review summary');
  }
};

const listPublicReviews = async (req, res) => {
  try {
    const { productId } = req.params;
    if (!isValidObjectId(productId)) {
      return jsonError(res, 400, 'INVALID_PRODUCT_ID', 'Invalid product id');
    }

    const exists = await Product.exists({ _id: productId });
    if (!exists) {
      return jsonError(res, 404, 'PRODUCT_NOT_FOUND', 'Product not found');
    }

    const storefront = resolveReviewStorefrontFromReq(req);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const skip = Math.max(0, parseInt(req.query.skip, 10) || 0);

    const docs = await ProductReview.find(
      mergeReviewStorefrontFilter(
        {
          productId,
          isActive: true
        },
        storefront
      )
    )
      .sort({ createdAt: -1, rating: -1 })
      .skip(skip)
      .limit(limit)
      .populate('userId', 'name')
      .lean();

    const reviews = docs.map((r) => ({
      _id: r._id,
      rating: r.rating,
      comment: r.comment || '',
      createdAt: r.createdAt,
      author: publicAuthorLabel(r),
      verifiedPurchase: Boolean(r.verifiedPurchase),
      source: r.source,
      storefront: normalizeReviewStorefront(r.storefront),
      images: mapPublicImages(r.images)
    }));

    return res.json({ success: true, scope: storefront, reviews });
  } catch (err) {
    console.error('[listPublicReviews]', err);
    return jsonError(res, 500, 'REVIEW_LIST_ERROR', 'Could not load reviews');
  }
};

// ─── User (customer) ────────────────────────────────────────────────────────

const getReviewEligibilityForProduct = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return jsonError(res, 401, 'UNAUTHORIZED', 'Login required');
    }

    const { productId } = req.params;
    if (!isValidObjectId(productId)) {
      return jsonError(res, 400, 'INVALID_PRODUCT_ID', 'Invalid product id');
    }

    const product = await Product.findById(productId).select('_id').lean();
    if (!product) {
      return jsonError(res, 404, 'PRODUCT_NOT_FOUND', 'Product not found');
    }

    const storefront = resolveReviewStorefrontFromReq(req);
    const eligibility = await getProductReviewEligibility(userId, productId, { storefront });
    return res.json({
      success: true,
      scope: storefront,
      eligibility: {
        canCreate: Boolean(eligibility.canCreate),
        canUpdate: Boolean(eligibility.canUpdate),
        hasReview: Boolean(eligibility.hasReview),
        qualifyingOrderId: eligibility.qualifyingOrderId || null,
        verifiedPurchaseEligible: Boolean(eligibility.verifiedPurchaseEligible),
        canAttachImages: Boolean(eligibility.canAttachImages),
        review: eligibility.review
          ? {
              _id: eligibility.review._id,
              rating: eligibility.review.rating,
              comment: eligibility.review.comment || '',
              isActive: eligibility.review.isActive,
              verifiedPurchase: Boolean(eligibility.review.verifiedPurchase),
              orderId: eligibility.review.orderId || null,
              storefront: normalizeReviewStorefront(eligibility.review.storefront),
              images: mapPublicImages(eligibility.review.images),
              createdAt: eligibility.review.createdAt,
              updatedAt: eligibility.review.updatedAt
            }
          : null,
        code: eligibility.code,
        message: eligibility.message
      }
    });
  } catch (err) {
    console.error('[getReviewEligibilityForProduct]', err);
    return jsonError(res, 500, 'REVIEW_ELIGIBILITY_ERROR', 'Could not check review eligibility');
  }
};

const getReviewableItemsForOrder = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return jsonError(res, 401, 'UNAUTHORIZED', 'Login required');
    }

    const orderId = String(req.params.orderId || '').trim();
    if (!orderId) {
      return jsonError(res, 400, 'INVALID_ORDER_ID', 'Invalid order id');
    }

    const result = await getOrderReviewableItems(userId, orderId);
    if (result.code === 'ORDER_NOT_FOUND') {
      return jsonError(res, 404, 'ORDER_NOT_FOUND', result.message);
    }

    return res.json({
      success: true,
      eligible: Boolean(result.eligible),
      orderId: result.orderId || orderId,
      orderStatus: result.orderStatus,
      code: result.code,
      message: result.message,
      items: result.items || []
    });
  } catch (err) {
    console.error('[getReviewableItemsForOrder]', err);
    return jsonError(res, 500, 'ORDER_REVIEW_ITEMS_ERROR', 'Could not load reviewable items');
  }
};

const getMyReviewForProduct = async (req, res) => {
  try {
    const { productId } = req.params;
    const userId = req.user?.id;
    if (!userId) {
      return jsonError(res, 401, 'UNAUTHORIZED', 'Login required');
    }
    if (!isValidObjectId(productId)) {
      return jsonError(res, 400, 'INVALID_PRODUCT_ID', 'Invalid product id');
    }

    const storefront = resolveReviewStorefrontFromReq(req);
    const review = await ProductReview.findOne(
      mergeReviewStorefrontFilter(
        {
          productId,
          userId,
          source: 'customer'
        },
        storefront
      )
    ).lean();

    if (!review) {
      return res.json({ success: true, scope: storefront, review: null });
    }

    return res.json({
      success: true,
      scope: storefront,
      review: serializeCustomerReview(review)
    });
  } catch (err) {
    console.error('[getMyReviewForProduct]', err);
    return jsonError(res, 500, 'REVIEW_MINE_ERROR', 'Could not load your review');
  }
};

const createCustomerReview = async (req, res) => {
  let uploadedImages = [];
  try {
    const userId = req.user?.id;
    if (!userId) {
      return jsonError(res, 401, 'UNAUTHORIZED', 'Login required');
    }

    const {
      productId,
      rating: ratingRaw,
      comment: commentRaw,
      orderId: orderIdRaw,
      variantId: variantIdRaw
    } = parseReviewRequestBody(req);
    if (!isValidObjectId(productId)) {
      return jsonError(res, 400, 'INVALID_PRODUCT_ID', 'Invalid product id');
    }

    const rating = Number(ratingRaw);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return jsonError(res, 400, 'INVALID_RATING', 'Rating must be an integer from 1 to 5');
    }

    const comment = String(commentRaw || '').trim().slice(0, 2000);
    const orderIdHint = String(orderIdRaw || '').trim() || null;
    const variantIdHint =
      variantIdRaw && isValidObjectId(variantIdRaw) ? String(variantIdRaw) : null;

    const incomingFiles = getIncomingReviewImageFiles(req);
    if (incomingFiles.length > MAX_REVIEW_IMAGES) {
      return jsonError(
        res,
        400,
        'TOO_MANY_IMAGES',
        `You can upload up to ${MAX_REVIEW_IMAGES} images per review`
      );
    }

    const product = await Product.findById(productId).select('_id').lean();
    if (!product) {
      return jsonError(res, 404, 'PRODUCT_NOT_FOUND', 'Product not found');
    }

    const role = String(req.user?.role || '').toLowerCase();
    if (role === 'admin') {
      return jsonError(
        res,
        403,
        'USE_ADMIN_FLOW',
        'Admin accounts cannot submit customer reviews; use the admin reviews tool'
      );
    }

    const storefront = resolveReviewStorefrontFromReq(req);

    const existing = await ProductReview.findOne(
      mergeReviewStorefrontFilter(
        {
          productId,
          userId,
          source: 'customer'
        },
        storefront
      )
    )
      .select('_id')
      .lean();
    if (existing) {
      return jsonError(
        res,
        409,
        'REVIEW_ALREADY_EXISTS',
        'You have already reviewed this product. You can update your existing review.'
      );
    }

    const purchase = await findDeliveredPurchaseForProduct(userId, productId, {
      orderId: orderIdHint,
      storefront
    });

    // If client sent a specific orderId, it must be a valid delivered purchase.
    if (orderIdHint && (!purchase.eligible || !purchase.order)) {
      return jsonError(
        res,
        403,
        purchase.code || 'ORDER_NOT_ELIGIBLE',
        purchase.message ||
          'This order is not eligible for a verified review.'
      );
    }

    const linkedOrderId = purchase.eligible ? purchase.order.orderId : null;
    const linkedVariantId = purchase.eligible
      ? resolveVariantIdFromOrder(purchase.order, productId, variantIdHint)
      : null;
    const verifiedPurchase = Boolean(linkedOrderId);

    if (incomingFiles.length && !verifiedPurchase) {
      return jsonError(
        res,
        403,
        'PHOTOS_REQUIRE_PURCHASE',
        'Photos can only be added after you purchase and receive this product. Use My Orders to review with photos.'
      );
    }

    if (incomingFiles.length) {
      uploadedImages = await uploadReviewImages(incomingFiles, {
        productId: String(productId),
        userId: String(userId),
        orderId: linkedOrderId
      });
    }

    try {
      const review = await ProductReview.create({
        productId,
        userId,
        source: 'customer',
        storefront,
        rating,
        comment,
        images: uploadedImages,
        orderId: linkedOrderId || undefined,
        variantId: linkedVariantId || undefined,
        verifiedPurchase,
        isActive: false
      });

      await syncProductRatingFromReviews(productId);

      return res.status(201).json({
        success: true,
        message:
          'Thank you. Your review was submitted and will appear after moderation.',
        review: serializeCustomerReview(review)
      });
    } catch (e) {
      if (uploadedImages.length) {
        await deleteReviewImagesFromCloudinary(uploadedImages);
        uploadedImages = [];
      }
      if (e && e.code === 11000) {
        return jsonError(
          res,
          409,
          'REVIEW_ALREADY_EXISTS',
          'You have already reviewed this product. You can update your existing review.'
        );
      }
      throw e;
    }
  } catch (err) {
    if (uploadedImages.length) {
      await deleteReviewImagesFromCloudinary(uploadedImages);
    }
    console.error('[createCustomerReview]', err);
    return jsonError(res, 500, 'REVIEW_CREATE_ERROR', 'Could not submit review');
  }
};

const updateCustomerReview = async (req, res) => {
  let uploadedImages = [];
  try {
    const userId = req.user?.id;
    if (!userId) {
      return jsonError(res, 401, 'UNAUTHORIZED', 'Login required');
    }

    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return jsonError(res, 400, 'INVALID_REVIEW_ID', 'Invalid review id');
    }

    const { rating: ratingRaw, comment: commentRaw, removeImagePublicIds } =
      parseReviewRequestBody(req);
    const patch = {};
    const incomingFiles = getIncomingReviewImageFiles(req);

    if (ratingRaw !== undefined && ratingRaw !== null && String(ratingRaw).trim() !== '') {
      const rating = Number(ratingRaw);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        return jsonError(res, 400, 'INVALID_RATING', 'Rating must be an integer from 1 to 5');
      }
      patch.rating = rating;
    }

    if (commentRaw !== undefined) {
      patch.comment = String(commentRaw || '').trim().slice(0, 2000);
    }

    const storefront = resolveReviewStorefrontFromReq(req);
    const review = await ProductReview.findOne(
      mergeReviewStorefrontFilter(
        {
          _id: id,
          userId,
          source: 'customer'
        },
        storefront
      )
    );

    if (!review) {
      return jsonError(res, 404, 'REVIEW_NOT_FOUND', 'Review not found');
    }

    const existingImages = normalizeStoredImages(review.images);
    const removeSet = new Set(removeImagePublicIds || []);
    const keptImages = existingImages.filter((img) => {
      if (img.publicId && removeSet.has(img.publicId)) return false;
      if (img.url && removeSet.has(img.url)) return false;
      return true;
    });
    const removedImages = existingImages.filter((img) => {
      if (img.publicId && removeSet.has(img.publicId)) return true;
      if (img.url && removeSet.has(img.url)) return true;
      return false;
    });

    if (incomingFiles.length > MAX_REVIEW_IMAGES) {
      return jsonError(
        res,
        400,
        'TOO_MANY_IMAGES',
        `You can upload up to ${MAX_REVIEW_IMAGES} images per review`
      );
    }

    if (keptImages.length + incomingFiles.length > MAX_REVIEW_IMAGES) {
      return jsonError(
        res,
        400,
        'TOO_MANY_IMAGES',
        `You can have at most ${MAX_REVIEW_IMAGES} images per review`
      );
    }

    if (incomingFiles.length && !Boolean(review.verifiedPurchase)) {
      return jsonError(
        res,
        403,
        'PHOTOS_REQUIRE_PURCHASE',
        'Photos can only be added on verified purchase reviews. Manage photos from My Orders after delivery.'
      );
    }

    if (incomingFiles.length) {
      uploadedImages = await uploadReviewImages(incomingFiles, {
        productId: String(review.productId),
        userId: String(userId),
        orderId: review.orderId
      });
    }

    const nextImages = [...keptImages, ...uploadedImages];
    const hasImageChanges =
      incomingFiles.length > 0 || removedImages.length > 0;

    if (
      Object.keys(patch).length === 0 &&
      !hasImageChanges
    ) {
      return jsonError(res, 400, 'NO_CHANGES', 'No valid fields to update');
    }

    Object.assign(review, patch);
    if (hasImageChanges) {
      review.images = nextImages;
    }

    await review.save();
    if (removedImages.length) {
      await deleteReviewImagesFromCloudinary(removedImages);
    }
    await syncProductRatingFromReviews(review.productId);

    return res.json({
      success: true,
      message: 'Review updated',
      review: serializeCustomerReview(review)
    });
  } catch (err) {
    if (uploadedImages.length) {
      await deleteReviewImagesFromCloudinary(uploadedImages);
    }
    console.error('[updateCustomerReview]', err);
    return jsonError(res, 500, 'REVIEW_UPDATE_ERROR', 'Could not update review');
  }
};

// ─── Admin ──────────────────────────────────────────────────────────────────

const listAdminReviews = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;
    const storefront = resolveReviewStorefrontFromReq(req);

    const base = {};
    if (req.query.productId && isValidObjectId(req.query.productId)) {
      base.productId = req.query.productId;
    }
    if (req.query.source === 'customer' || req.query.source === 'admin') {
      base.source = req.query.source;
    }
    if (req.query.isActive === 'true') base.isActive = true;
    if (req.query.isActive === 'false') base.isActive = false;

    const query = mergeReviewStorefrontFilter(base, storefront);

    const [total, docs] = await Promise.all([
      ProductReview.countDocuments(query),
      ProductReview.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('productId', 'title slug name variants.images')
        .populate('userId', 'name phone email')
        .lean()
    ]);

    const reviews = docs.map((r) => {
      const p = r.productId;
      const thumb =
        p?.variants?.[0]?.images?.[0]?.url ||
        p?.variants?.flatMap((v) => v.images || []).find((i) => i?.url)?.url ||
        null;
      return {
        _id: r._id,
        source: r.source,
        storefront: normalizeReviewStorefront(r.storefront),
        rating: r.rating,
        comment: r.comment || '',
        isActive: r.isActive,
        verifiedPurchase: Boolean(r.verifiedPurchase),
        orderId: r.orderId || null,
        images: mapPublicImages(r.images),
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        displayName: r.displayName || '',
        product: p
          ? {
              _id: p._id,
              title: p.title || p.name,
              slug: p.slug,
              thumb
            }
          : null,
        customer:
          r.source === 'customer' && r.userId
            ? {
                name: r.userId.name || '',
                phone: r.userId.phone || '',
                email: r.userId.email || ''
              }
            : null
      };
    });

    return res.json({
      success: true,
      scope: storefront,
      reviews,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) || 0 }
    });
  } catch (err) {
    console.error('[listAdminReviews]', err);
    return jsonError(res, 500, 'ADMIN_REVIEW_LIST_ERROR', 'Could not load reviews');
  }
};

const patchReviewStatus = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return jsonError(res, 400, 'INVALID_REVIEW_ID', 'Invalid review id');
    }

    const isActive = req.body?.isActive;
    if (typeof isActive !== 'boolean') {
      return jsonError(res, 400, 'INVALID_STATUS', 'isActive (boolean) is required');
    }

    const storefront = resolveReviewStorefrontFromReq(req);
    const review = await ProductReview.findOne(
      mergeReviewStorefrontFilter({ _id: id }, storefront)
    );
    if (!review) {
      return jsonError(res, 404, 'REVIEW_NOT_FOUND', 'Review not found');
    }

    review.isActive = isActive;
    await review.save();
    await syncProductRatingFromReviews(review.productId);

    return res.json({
      success: true,
      message: 'Review status updated',
      review: {
        _id: review._id,
        isActive: review.isActive,
        storefront: normalizeReviewStorefront(review.storefront)
      }
    });
  } catch (err) {
    console.error('[patchReviewStatus]', err);
    return jsonError(res, 500, 'ADMIN_REVIEW_PATCH_ERROR', 'Could not update status');
  }
};

const createAdminGeneratedReview = async (req, res) => {
  try {
    const { productId, rating: ratingRaw, comment, displayName, isActive } = req.body || {};
    const storefront = resolveReviewStorefrontFromReq(req);

    if (!isValidObjectId(productId)) {
      return jsonError(res, 400, 'INVALID_PRODUCT_ID', 'Invalid product id');
    }

    const rating = Number(ratingRaw);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return jsonError(res, 400, 'INVALID_RATING', 'Rating must be an integer from 1 to 5');
    }

    const product = await Product.findById(productId).select('_id').lean();
    if (!product) {
      return jsonError(res, 404, 'PRODUCT_NOT_FOUND', 'Product not found');
    }

    const review = await ProductReview.create({
      productId,
      source: 'admin',
      storefront,
      rating,
      comment: String(comment || '').trim().slice(0, 2000),
      displayName: String(displayName || '').trim().slice(0, 120),
      isActive: typeof isActive === 'boolean' ? isActive : true
    });

    await syncProductRatingFromReviews(productId);

    return res.status(201).json({
      success: true,
      message: 'Generated review created',
      review: {
        _id: review._id,
        storefront: review.storefront,
        rating: review.rating,
        comment: review.comment,
        displayName: review.displayName,
        isActive: review.isActive
      }
    });
  } catch (err) {
    console.error('[createAdminGeneratedReview]', err);
    return jsonError(res, 500, 'ADMIN_REVIEW_CREATE_ERROR', 'Could not create review');
  }
};

const updateAdminGeneratedReview = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return jsonError(res, 400, 'INVALID_REVIEW_ID', 'Invalid review id');
    }

    const storefront = resolveReviewStorefrontFromReq(req);
    const review = await ProductReview.findOne(
      mergeReviewStorefrontFilter({ _id: id, source: 'admin' }, storefront)
    );
    if (!review) {
      return jsonError(res, 404, 'REVIEW_NOT_FOUND', 'Generated review not found');
    }

    const { rating: ratingRaw, comment, displayName, isActive } = req.body || {};

    if (ratingRaw !== undefined) {
      const rating = Number(ratingRaw);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        return jsonError(res, 400, 'INVALID_RATING', 'Rating must be an integer from 1 to 5');
      }
      review.rating = rating;
    }
    if (comment !== undefined) {
      review.comment = String(comment || '').trim().slice(0, 2000);
    }
    if (displayName !== undefined) {
      review.displayName = String(displayName || '').trim().slice(0, 120);
    }
    if (typeof isActive === 'boolean') {
      review.isActive = isActive;
    }

    await review.save();
    await syncProductRatingFromReviews(review.productId);

    return res.json({
      success: true,
      message: 'Review updated',
      review: {
        _id: review._id,
        storefront: review.storefront,
        rating: review.rating,
        comment: review.comment,
        displayName: review.displayName,
        isActive: review.isActive
      }
    });
  } catch (err) {
    console.error('[updateAdminGeneratedReview]', err);
    return jsonError(res, 500, 'ADMIN_REVIEW_UPDATE_ERROR', 'Could not update review');
  }
};

const deleteAdminGeneratedReview = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return jsonError(res, 400, 'INVALID_REVIEW_ID', 'Invalid review id');
    }

    const storefront = resolveReviewStorefrontFromReq(req);
    const review = await ProductReview.findOne(
      mergeReviewStorefrontFilter({ _id: id, source: 'admin' }, storefront)
    );
    if (!review) {
      return jsonError(res, 404, 'REVIEW_NOT_FOUND', 'Generated review not found');
    }

    const productId = review.productId;
    const images = normalizeStoredImages(review.images);
    await review.deleteOne();
    if (images.length) {
      await deleteReviewImagesFromCloudinary(images);
    }
    await syncProductRatingFromReviews(productId);

    return res.json({ success: true, message: 'Review deleted' });
  } catch (err) {
    console.error('[deleteAdminGeneratedReview]', err);
    return jsonError(res, 500, 'ADMIN_REVIEW_DELETE_ERROR', 'Could not delete review');
  }
};

const deleteCustomerReview = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return jsonError(res, 401, 'UNAUTHORIZED', 'Login required');
    }

    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return jsonError(res, 400, 'INVALID_REVIEW_ID', 'Invalid review id');
    }

    const review = await ProductReview.findOne(
      mergeReviewStorefrontFilter(
        {
          _id: id,
          userId,
          source: 'customer'
        },
        resolveReviewStorefrontFromReq(req)
      )
    );

    if (!review) {
      return jsonError(res, 404, 'REVIEW_NOT_FOUND', 'Review not found');
    }

    const productId = review.productId;
    const images = normalizeStoredImages(review.images);
    await review.deleteOne();
    if (images.length) {
      await deleteReviewImagesFromCloudinary(images);
    }
    await syncProductRatingFromReviews(productId);

    return res.json({
      success: true,
      message: 'Your review was deleted'
    });
  } catch (err) {
    console.error('[deleteCustomerReview]', err);
    return jsonError(res, 500, 'REVIEW_DELETE_ERROR', 'Could not delete review');
  }
};

module.exports = {
  getPublicSummary,
  listPublicReviews,
  getReviewEligibilityForProduct,
  getReviewableItemsForOrder,
  getMyReviewForProduct,
  createCustomerReview,
  updateCustomerReview,
  deleteCustomerReview,
  listAdminReviews,
  patchReviewStatus,
  createAdminGeneratedReview,
  updateAdminGeneratedReview,
  deleteAdminGeneratedReview
};
