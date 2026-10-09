'use strict';

const catalogService = require('../services/catalog.service');

function sendError(res, error, fallbackMessage) {
  const status = error.statusCode || 500;
  if (status >= 500) {
    console.error('dropshipper catalog:', error);
  }
  return res.status(status).json({
    success: false,
    code: error.code || (status === 500 ? 'DROPSHIP_CATALOG_ERROR' : 'DROPSHIP_ERROR'),
    message: error.message || fallbackMessage
  });
}

/**
 * GET /api/dropshipper/catalog/products
 */
const listProducts = async (req, res) => {
  try {
    const inStockOnly =
      req.query.inStockOnly === 'true' ||
      req.query.inStockOnly === '1' ||
      req.query.inStockOnly === true;

    const result = await catalogService.listCatalogProducts({
      page: req.query.page,
      limit: req.query.limit,
      q: req.query.q || req.query.search,
      categoryId: req.query.categoryId || req.query.category,
      inStockOnly,
      sort: req.query.sort
    });

    return res.status(200).json({
      success: true,
      message: 'Dropship catalog fetched successfully',
      ...result
    });
  } catch (error) {
    return sendError(res, error, 'Failed to fetch dropship catalog');
  }
};

/**
 * GET /api/dropshipper/catalog/products/:slug
 */
const getProductBySlug = async (req, res) => {
  try {
    const product = await catalogService.getCatalogProductBySlug(req.params.slug);
    return res.status(200).json({
      success: true,
      message: 'Dropship product fetched successfully',
      product
    });
  } catch (error) {
    return sendError(res, error, 'Failed to fetch dropship product');
  }
};

/**
 * GET /api/dropshipper/catalog/variants/:productCode
 */
const getVariantByProductCode = async (req, res) => {
  try {
    const data = await catalogService.getCatalogVariantByProductCode(
      req.params.productCode
    );
    return res.status(200).json({
      success: true,
      message: 'Dropship variant fetched successfully',
      ...data
    });
  } catch (error) {
    return sendError(res, error, 'Failed to fetch dropship variant');
  }
};

/**
 * GET /api/dropshipper/catalog/variants/:productCode/download-pack
 */
const getVariantDownloadPack = async (req, res) => {
  try {
    const data = await catalogService.getVariantDownloadPack(req.params.productCode);
    return res.status(200).json({
      success: true,
      message: 'Download pack ready',
      ...data
    });
  } catch (error) {
    return sendError(res, error, 'Failed to build download pack');
  }
};

module.exports = {
  listProducts,
  getProductBySlug,
  getVariantByProductCode,
  getVariantDownloadPack
};
