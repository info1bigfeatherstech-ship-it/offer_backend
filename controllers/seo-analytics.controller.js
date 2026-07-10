const SeoAnalyticsService = require('../services/seo-analytics.service');

// Lazy singleton — never construct at module load (missing GA creds must not crash boot).
let analyticsService = null;

const getAnalyticsService = () => {
  if (!analyticsService) {
    analyticsService = new SeoAnalyticsService();
  }
  return analyticsService;
};

const sendJsonResponse = (res, status, payload) => {
  return res.status(status).json(payload);
};

const getOverview = async (req, res) => {
  try {
    const overview = await getAnalyticsService().getOverview();
    return sendJsonResponse(res, 200, {
      success: true,
      data: overview
    });
  } catch (error) {
    console.error('[SeoAnalytics][Overview] Error:', error.message);
    return sendJsonResponse(res, error.statusCode || 500, {
      success: false,
      message: error.message || 'Unable to load analytics overview'
    });
  }
};

const getTraffic = async (req, res) => {
  try {
    const range = req.query.range || '7d';
    const trafficData = await getAnalyticsService().getTraffic(range);

    return sendJsonResponse(res, 200, {
      success: true,
      range,
      data: trafficData
    });
  } catch (error) {
    console.error('[SeoAnalytics][Traffic] Error:', error.message);
    return sendJsonResponse(res, error.statusCode || 500, {
      success: false,
      message: error.message || 'Unable to load traffic analytics'
    });
  }
};

const getDevices = async (req, res) => {
  try {
    const deviceCounts = await getAnalyticsService().getDevices();
    return sendJsonResponse(res, 200, {
      success: true,
      data: deviceCounts
    });
  } catch (error) {
    console.error('[SeoAnalytics][Devices] Error:', error.message);
    return sendJsonResponse(res, error.statusCode || 500, {
      success: false,
      message: error.message || 'Unable to load device analytics'
    });
  }
};

const getSources = async (req, res) => {
  try {
    const sources = await getAnalyticsService().getSources();
    return sendJsonResponse(res, 200, {
      success: true,
      data: sources
    });
  } catch (error) {
    console.error('[SeoAnalytics][Sources] Error:', error.message);
    return sendJsonResponse(res, error.statusCode || 500, {
      success: false,
      message: error.message || 'Unable to load source analytics'
    });
  }
};

const getLocations = async (req, res) => {
  try {
    const locations = await getAnalyticsService().getLocations();
    return sendJsonResponse(res, 200, {
      success: true,
      data: locations
    });
  } catch (error) {
    console.error('[SeoAnalytics][Locations] Error:', error.message);
    return sendJsonResponse(res, error.statusCode || 500, {
      success: false,
      message: error.message || 'Unable to load location analytics'
    });
  }
};

module.exports = {
  getOverview,
  getTraffic,
  getDevices,
  getSources,
  getLocations
};
