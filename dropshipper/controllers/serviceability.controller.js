'use strict';

const serviceabilityService = require('../services/serviceability.service');

function sendError(res, error, fallbackMessage) {
  const status = error.statusCode || 500;
  return res.status(status).json({
    success: false,
    code: error.code || (status === 500 ? 'DROPSHIP_SERVICEABILITY_ERROR' : 'DROPSHIP_ERROR'),
    message: error.message || fallbackMessage
  });
}

/**
 * POST /api/dropshipper/serviceability/check
 */
const checkServiceability = async (req, res) => {
  try {
    const result = await serviceabilityService.checkServiceability(req.body || {});

    return res.status(200).json({
      success: true,
      message: result.isDeliverable
        ? 'Delivery available for this route'
        : 'Delivery not available for this route',
      ...result
    });
  } catch (error) {
    if (!error.statusCode) {
      console.error('dropshipper checkServiceability:', error);
    }
    return sendError(res, error, 'Failed to check dropship serviceability');
  }
};

module.exports = {
  checkServiceability
};
