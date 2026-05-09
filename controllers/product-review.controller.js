const mongoose = require('mongoose');
const Product = require('../models/Product');
const ProductReview = require('../models/ProductReview');
const { syncProductRatingFromReviews } = require('../services/productReviewSync.service');

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(String(id));

function jsonError(res, status, code, message, details) {
  return res.status(status).json({
    success: false,
    code,
    message,
    ...(details ? { details } : {})
  });
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

// ─── Public ───────────────────────────────────────────────────────────────

const getPublicSummary = async (req, res) => {
  try {
    const { productId } = req.params;
    if (!isValidObjectId(productId)) {
      return jsonError(res, 400, 'INVALID_PRODUCT_ID', 'Invalid product id');
    }

    const product = await Product.findById(productId).select('rating').lean();
    if (!product) {
      return jsonError(res, 404, 'PRODUCT_NOT_FOUND', 'Product not found');
    }

    const count = product.rating?.count ?? 0;
    const value = count > 0 ? product.rating?.value ?? null : null;

    return res.json({
      success: true,
      summary: {
        averageRating: value,
        reviewCount: count
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

    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const skip = Math.max(0, parseInt(req.query.skip, 10) || 0);

    const docs = await ProductReview.find({
      productId,
      isActive: true
    })
      .sort({ rating: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('userId', 'name')
      .lean();

    const reviews = docs.map((r) => ({
      _id: r._id,
      rating: r.rating,
      comment: r.comment || '',
      createdAt: r.createdAt,
      author: publicAuthorLabel(r)
    }));

    return res.json({ success: true, reviews });
  } catch (err) {
    console.error('[listPublicReviews]', err);
    return jsonError(res, 500, 'REVIEW_LIST_ERROR', 'Could not load reviews');
  }
};

// ─── User (customer) ────────────────────────────────────────────────────────

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

    const review = await ProductReview.findOne({
      productId,
      userId,
      source: 'customer'
    }).lean();

    if (!review) {
      return res.json({ success: true, review: null });
    }

    return res.json({
      success: true,
      review: {
        _id: review._id,
        rating: review.rating,
        comment: review.comment || '',
        isActive: review.isActive,
        createdAt: review.createdAt,
        updatedAt: review.updatedAt
      }
    });
  } catch (err) {
    console.error('[getMyReviewForProduct]', err);
    return jsonError(res, 500, 'REVIEW_MINE_ERROR', 'Could not load your review');
  }
};

const createCustomerReview = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return jsonError(res, 401, 'UNAUTHORIZED', 'Login required');
    }

    const { productId, rating: ratingRaw, comment: commentRaw } = req.body || {};
    if (!isValidObjectId(productId)) {
      return jsonError(res, 400, 'INVALID_PRODUCT_ID', 'Invalid product id');
    }

    const rating = Number(ratingRaw);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return jsonError(res, 400, 'INVALID_RATING', 'Rating must be an integer from 1 to 5');
    }

    const comment = String(commentRaw || '').trim().slice(0, 2000);

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

    try {
      const review = await ProductReview.create({
        productId,
        userId,
        source: 'customer',
        rating,
        comment,
        isActive: false
      });

      await syncProductRatingFromReviews(productId);

      return res.status(201).json({
        success: true,
        message:
          'Thank you. Your review was submitted and will appear after moderation.',
        review: {
          _id: review._id,
          rating: review.rating,
          comment: review.comment,
          isActive: review.isActive,
          createdAt: review.createdAt
        }
      });
    } catch (e) {
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
    console.error('[createCustomerReview]', err);
    return jsonError(res, 500, 'REVIEW_CREATE_ERROR', 'Could not submit review');
  }
};

const updateCustomerReview = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return jsonError(res, 401, 'UNAUTHORIZED', 'Login required');
    }

    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return jsonError(res, 400, 'INVALID_REVIEW_ID', 'Invalid review id');
    }

    const { rating: ratingRaw, comment: commentRaw } = req.body || {};
    const patch = {};

    if (ratingRaw !== undefined) {
      const rating = Number(ratingRaw);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        return jsonError(res, 400, 'INVALID_RATING', 'Rating must be an integer from 1 to 5');
      }
      patch.rating = rating;
    }

    if (commentRaw !== undefined) {
      patch.comment = String(commentRaw || '').trim().slice(0, 2000);
    }

    if (Object.keys(patch).length === 0) {
      return jsonError(res, 400, 'NO_CHANGES', 'No valid fields to update');
    }

    const review = await ProductReview.findOne({
      _id: id,
      userId,
      source: 'customer'
    });

    if (!review) {
      return jsonError(res, 404, 'REVIEW_NOT_FOUND', 'Review not found');
    }

    Object.assign(review, patch);
    await review.save();
    await syncProductRatingFromReviews(review.productId);

    return res.json({
      success: true,
      message: 'Review updated',
      review: {
        _id: review._id,
        rating: review.rating,
        comment: review.comment,
        isActive: review.isActive,
        updatedAt: review.updatedAt
      }
    });
  } catch (err) {
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

    const query = {};
    if (req.query.productId && isValidObjectId(req.query.productId)) {
      query.productId = req.query.productId;
    }
    if (req.query.source === 'customer' || req.query.source === 'admin') {
      query.source = req.query.source;
    }
    if (req.query.isActive === 'true') query.isActive = true;
    if (req.query.isActive === 'false') query.isActive = false;

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
        rating: r.rating,
        comment: r.comment || '',
        isActive: r.isActive,
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

    const review = await ProductReview.findById(id);
    if (!review) {
      return jsonError(res, 404, 'REVIEW_NOT_FOUND', 'Review not found');
    }

    review.isActive = isActive;
    await review.save();
    await syncProductRatingFromReviews(review.productId);

    return res.json({
      success: true,
      message: 'Review status updated',
      review: { _id: review._id, isActive: review.isActive }
    });
  } catch (err) {
    console.error('[patchReviewStatus]', err);
    return jsonError(res, 500, 'ADMIN_REVIEW_PATCH_ERROR', 'Could not update status');
  }
};

const createAdminGeneratedReview = async (req, res) => {
  try {
    const { productId, rating: ratingRaw, comment, displayName, isActive } = req.body || {};

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

    const review = await ProductReview.findById(id);
    if (!review || review.source !== 'admin') {
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

    const review = await ProductReview.findById(id);
    if (!review || review.source !== 'admin') {
      return jsonError(res, 404, 'REVIEW_NOT_FOUND', 'Generated review not found');
    }

    const productId = review.productId;
    await review.deleteOne();
    await syncProductRatingFromReviews(productId);

    return res.json({ success: true, message: 'Review deleted' });
  } catch (err) {
    console.error('[deleteAdminGeneratedReview]', err);
    return jsonError(res, 500, 'ADMIN_REVIEW_DELETE_ERROR', 'Could not delete review');
  }
};

module.exports = {
  getPublicSummary,
  listPublicReviews,
  getMyReviewForProduct,
  createCustomerReview,
  updateCustomerReview,
  listAdminReviews,
  patchReviewStatus,
  createAdminGeneratedReview,
  updateAdminGeneratedReview,
  deleteAdminGeneratedReview
};
