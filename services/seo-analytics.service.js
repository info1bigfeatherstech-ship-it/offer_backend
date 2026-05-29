const { BetaAnalyticsDataClient } = require('@google-analytics/data');

const DATE_RANGE_MAP = {
  '7d': 7,
  '30d': 30,
  '90d': 90
};

const KNOWN_SOURCE_GROUPS = [
  'google',
  'instagram',
  'facebook',
  'direct',
  'bing',
  'twitter',
  'youtube',
  'linkedin',
  'tiktok'
]; 

const isBlankValue = (value) => {
  return value === undefined || value === null || value === '' || value === '(not set)';
};

const parseNumber = (value) => {
  if (value === undefined || value === null || value === '') {
    return 0;
  }
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

class seoAnalyticsService {
  constructor() {
    this.initializeConfig();
    this.client = new BetaAnalyticsDataClient();
  }

  initializeConfig() {
    if (!process.env.GA_PROPERTY_ID) {
      const error = new Error('GA_PROPERTY_ID environment variable must be set');
      error.statusCode = 500;
      throw error;
    }

    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      const error = new Error('GOOGLE_APPLICATION_CREDENTIALS environment variable must be set');
      error.statusCode = 500;
      throw error;
    }

    this.propertyId = process.env.GA_PROPERTY_ID;
  }

  getPropertyName() {
    return `properties/${this.propertyId}`;
  }

  getDateRange(range) {
    const days = DATE_RANGE_MAP[range];
    if (!days) {
      const error = new Error('Invalid range. Allowed values: 7d, 30d, 90d');
      error.statusCode = 400;
      throw error;
    }

    return {
      startDate: `${days}daysAgo`,
      endDate: 'today'
    };
  }

  async runReport(reportOptions) {
    const request = {
      property: this.getPropertyName(),
      ...reportOptions
    };

    const response = await this.client.runReport(request);
    return response;
  }

  async getOverview() {
    const response = await this.runReport({
      dateRanges: [this.getDateRange('7d')],
      metrics: [
        { name: 'totalUsers' },
        { name: 'newUsers' },
        { name: 'activeUsers' },
        { name: 'bounceRate' },
        { name: 'averageSessionDuration' }
      ]
    });

    const row = response.rows?.[0];
    const metricValues = row?.metricValues || [];

    return {
      totalUsers: parseNumber(metricValues[0]?.value),
      newUsers: parseNumber(metricValues[1]?.value),
      activeUsers: parseNumber(metricValues[2]?.value),
      bounceRate: parseNumber(metricValues[3]?.value),
      averageSessionDuration: parseNumber(metricValues[4]?.value)
    };
  }

  async getTraffic(range) {
    const response = await this.runReport({
      dateRanges: [this.getDateRange(range)],
      dimensions: [{ name: 'date' }],
      metrics: [
        { name: 'activeUsers' },
        { name: 'sessions' },
        { name: 'newUsers' }
      ]
    });

    return (response.rows || []).map((row) => {
      const date = row.dimensionValues?.[0]?.value || 'unknown';
      const activeUsers = parseNumber(row.metricValues?.[0]?.value);
      const sessions = parseNumber(row.metricValues?.[1]?.value);
      const newUsers = parseNumber(row.metricValues?.[2]?.value);

      return {
        date,
        activeUsers,
        sessions,
        newUsers
      };
    });
  }

  async getDevices() {
    const response = await this.runReport({
      dateRanges: [this.getDateRange('30d')],
      dimensions: [{ name: 'deviceCategory' }],
      metrics: [{ name: 'sessions' }]
    });

    const counts = {
      mobile: 0,
      desktop: 0,
      tablet: 0
    };

    (response.rows || []).forEach((row) => {
      const deviceCategory = row.dimensionValues?.[0]?.value?.toLowerCase() || 'unknown';
      const sessions = parseNumber(row.metricValues?.[0]?.value);

      if (deviceCategory === 'mobile') {
        counts.mobile += sessions;
      } else if (deviceCategory === 'desktop') {
        counts.desktop += sessions;
      } else if (deviceCategory === 'tablet') {
        counts.tablet += sessions;
      }
    });

    return counts;
  }

  normalizeSourceLabel(sourceValue) {
    if (isBlankValue(sourceValue)) {
      return 'direct';
    }

    const normalized = sourceValue.toLowerCase();
    for (const label of KNOWN_SOURCE_GROUPS) {
      if (normalized.includes(label)) {
        return label;
      }
    }

    if (normalized === 'google.com') {
      return 'google';
    }

    if (normalized === 'direct') {
      return 'direct';
    }

    return 'other';
  }

  async getSources() {
    const response = await this.runReport({
      dateRanges: [this.getDateRange('30d')],
      dimensions: [{ name: 'sessionSource' }],
      metrics: [{ name: 'sessions' }]
    });

    const sourceBreakdown = {};

    (response.rows || []).forEach((row) => {
      const sourceValue = row.dimensionValues?.[0]?.value || '';
      const sessions = parseNumber(row.metricValues?.[0]?.value);
      const label = this.normalizeSourceLabel(sourceValue);
      sourceBreakdown[label] = (sourceBreakdown[label] || 0) + sessions;
    });

    return Object.entries(sourceBreakdown)
      .map(([source, sessions]) => ({ source, sessions }))
      .sort((a, b) => b.sessions - a.sessions);
  }

  async getLocations() {
    const response = await this.runReport({
      dateRanges: [this.getDateRange('30d')],
      dimensions: [{ name: 'city' }],
      metrics: [{ name: 'sessions' }],
      limit: 20
    });

    return (response.rows || [])
      .map((row) => {
        return {
          city: row.dimensionValues?.[0]?.value || 'Unknown',
          sessions: parseNumber(row.metricValues?.[0]?.value)
        };
      })
      .filter((item) => item.city && item.city.toLowerCase() !== '(not set)')
      .sort((a, b) => b.sessions - a.sessions)
      .slice(0, 10);
  }
}

module.exports =seoAnalyticsService;
