'use strict';

const adminDropshipProductService = require('../services/adminDropshipProduct.service');

function sendError(res, error, fallbackMessage) {
  const status = error.statusCode || 500;
  return res.status(status).json({
    success: false,
    code: error.code || (status === 500 ? 'DROPSHIP_INTERNAL_ERROR' : 'DROPSHIP_ERROR'),
    message: error.message || fallbackMessage,
    ...(status === 500 && process.env.NODE_ENV !== 'production'
      ? { error: error.message }
      : {})
  });
}

/**
 * GET /api/admin/dropshipper/products
 */
const listDropshipProducts = async (req, res) => {
  try {
    const listedOnly =
      req.query.listedOnly === 'true' ||
      req.query.listedOnly === '1' ||
      req.query.listedOnly === true;

    const result = await adminDropshipProductService.listDropshipProducts({
      page: req.query.page,
      limit: req.query.limit,
      listedOnly,
      q: req.query.q || req.query.search
    });

    return res.status(200).json({
      success: true,
      message: 'Dropship products fetched successfully',
      ...result
    });
  } catch (error) {
    console.error('listDropshipProducts:', error);
    return sendError(res, error, 'Failed to list dropship products');
  }
};

/**
 * GET /api/admin/dropshipper/products/:slug
 */
const getDropshipProduct = async (req, res) => {
  try {
    const product = await adminDropshipProductService.getDropshipProductBySlug(
      req.params.slug
    );
    return res.status(200).json({
      success: true,
      message: 'Dropship product fetched successfully',
      product
    });
  } catch (error) {
    console.error('getDropshipProduct:', error);
    return sendError(res, error, 'Failed to fetch dropship product');
  }
};

/**
 * PATCH /api/admin/dropshipper/products/:slug/variants/:productCode/price
 * Body: { dropshipBase: number, enable?: boolean }
 */
const setDropshipPrice = async (req, res) => {
  try {
    const result = await adminDropshipProductService.setVariantDropshipPrice({
      slug: req.params.slug,
      productCode: req.params.productCode,
      dropshipBase: req.body?.dropshipBase,
      enable: req.body?.enable === true
    });

    return res.status(200).json({
      success: true,
      message: req.body?.enable
        ? 'Dropship price set and listing enabled'
        : 'Dropship price set successfully',
      product: {
        slug: result.doc.slug,
        name: result.doc.name,
        channelStatus: result.doc.channelStatus
      },
      previous: result.previous,
      variant: result.current
    });
  } catch (error) {
    console.error('setDropshipPrice:', error);
    return sendError(res, error, 'Failed to set dropship price');
  }
};

/**
 * PATCH /api/admin/dropshipper/products/:slug/variants/:productCode/enable
 * Body: { dropshipBase?: number }  // optional if already priced
 */
const enableDropship = async (req, res) => {
  try {
    const result = await adminDropshipProductService.enableVariantDropship({
      slug: req.params.slug,
      productCode: req.params.productCode,
      dropshipBase: req.body?.dropshipBase
    });

    return res.status(200).json({
      success: true,
      message: 'Dropship listing enabled',
      product: {
        slug: result.doc.slug,
        name: result.doc.name,
        channelStatus: result.doc.channelStatus
      },
      previous: result.previous,
      variant: result.current
    });
  } catch (error) {
    console.error('enableDropship:', error);
    return sendError(res, error, 'Failed to enable dropship');
  }
};

/**
 * PATCH /api/admin/dropshipper/products/:slug/variants/:productCode/disable
 * Body: { clearPrice?: boolean }
 */
const disableDropship = async (req, res) => {
  try {
    const result = await adminDropshipProductService.disableVariantDropship({
      slug: req.params.slug,
      productCode: req.params.productCode,
      clearPrice: req.body?.clearPrice === true
    });

    return res.status(200).json({
      success: true,
      message: 'Dropship listing disabled',
      product: {
        slug: result.doc.slug,
        name: result.doc.name,
        channelStatus: result.doc.channelStatus
      },
      previous: result.previous,
      variant: result.current
    });
  } catch (error) {
    console.error('disableDropship:', error);
    return sendError(res, error, 'Failed to disable dropship');
  }
};

/**
 * POST /api/admin/dropshipper/products/bulk-enable
 * Body: { items: [{ productCode, slug?, dropshipBase? }, ...] }
 * Missing price → skip + report (does not fail whole batch).
 */
const bulkEnableDropship = async (req, res) => {
  try {
    const items = req.body?.items;
    const result = await adminDropshipProductService.bulkEnableDropship(items);

    return res.status(200).json({
      success: true,
      message: 'Bulk dropship enable completed',
      ...result
    });
  } catch (error) {
    console.error('bulkEnableDropship:', error);
    return sendError(res, error, 'Failed to bulk-enable dropship');
  }
};

/**
 * POST /api/admin/dropshipper/products/bulk-set-price
 * Body: { items: [{ productCode, dropshipBase, slug?, enable? }, ...] }
 */
const bulkSetDropshipPrice = async (req, res) => {
  try {
    const items = req.body?.items;
    const result = await adminDropshipProductService.bulkSetDropshipPrice(items);

    return res.status(200).json({
      success: true,
      message: 'Bulk dropship price update completed',
      ...result
    });
  } catch (error) {
    console.error('bulkSetDropshipPrice:', error);
    return sendError(res, error, 'Failed to bulk-set dropship price');
  }
};

module.exports = {
  listDropshipProducts,
  getDropshipProduct,
  setDropshipPrice,
  enableDropship,
  disableDropship,
  bulkEnableDropship,
  bulkSetDropshipPrice
};
