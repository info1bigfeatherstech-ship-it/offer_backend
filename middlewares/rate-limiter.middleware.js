const rateLimit = require('express-rate-limit');
const logger = require('../utils/logger');

function resolveRateLimitKey(req, type) {
  const userId = req?.user?._id || req?.user?.id || null;
  if (userId) {
    return `${type}:user:${String(userId)}`;
  }
  return `${type}:ip:${req.ip}`;
}

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number.parseInt(String(raw).trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envWindowMs(name, fallbackMs) {
  const seconds = envInt(name, 0);
  if (seconds > 0) return seconds * 1000;
  return fallbackMs;
}

/**
 * Remaining seconds until the current rate-limit window resets.
 * Falls back to full window if resetTime is unavailable.
 */
function resolveRetryAfterSeconds(req, windowMs) {
  const resetTime = req?.rateLimit?.resetTime;
  if (resetTime instanceof Date && !Number.isNaN(resetTime.getTime())) {
    return Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / 1000));
  }
  if (typeof resetTime === 'number' && Number.isFinite(resetTime)) {
    return Math.max(1, Math.ceil((resetTime - Date.now()) / 1000));
  }
  return Math.max(1, Math.ceil(windowMs / 1000));
}

// Different limits for different endpoints (Industry standard).
// Public browse limits are env-overridable for live traffic tuning without code changes.
const rateLimits = {
  // Public read (products, categories) — high enough for home multi-section + load-more
  publicRead: {
    windowMs: envWindowMs('RATE_LIMIT_PUBLIC_READ_WINDOW_SEC', 15 * 60 * 1000),
    max: envInt('RATE_LIMIT_PUBLIC_READ_MAX', 5000),
    message: 'Too many requests, please slow down'
  },

  search: {
    windowMs: envWindowMs('RATE_LIMIT_SEARCH_WINDOW_SEC', 15 * 60 * 1000),
    max: envInt('RATE_LIMIT_SEARCH_MAX', 400),
    message: 'Search limit exceeded, please wait'
  },

  write: {
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: 'Too many write operations'
  },

  cartWrite: {
    windowMs: 15 * 60 * 1000,
    max: 180,
    message: 'Too many cart operations. Please slow down'
  },

  couponWrite: {
    windowMs: 15 * 60 * 1000,
    max: 80,
    message: 'Too many coupon operations. Please wait and try again'
  },

  checkoutQuote: {
    windowMs: 15 * 60 * 1000,
    max: 60,
    message: 'Too many checkout quote requests. Please wait a moment'
  },

  checkoutConfirm: {
    windowMs: 15 * 60 * 1000,
    max: 40,
    message: 'Too many checkout confirmation attempts. Please retry shortly'
  },

  sensitive: {
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: 'Too many attempts, please try later'
  },

  orders: {
    windowMs: 15 * 60 * 1000,
    max: 400,
    message: 'Too many order requests, please wait a moment'
  },

  admin: {
    windowMs: 15 * 60 * 1000,
    max: 500,
    message: 'Admin rate limit exceeded'
  },

  pushWrite: {
    windowMs: 15 * 60 * 1000,
    max: 30,
    message: 'Too many push subscription updates. Please try again later'
  }
};

const createRateLimiter = (type, skipPaths = []) => {
  const config = rateLimits[type];
  if (!config) throw new Error(`Invalid rate limit type: ${type}`);

  return rateLimit({
    windowMs: config.windowMs,
    max: config.max,
    skip: (req) => skipPaths.includes(req.path),
    keyGenerator: (req) => resolveRateLimitKey(req, type),
    standardHeaders: true,
    legacyHeaders: false,
    // express-rate-limit v8: validate keyGenerator IP when trust proxy is set
    validate: { xForwardedForHeader: false },
    handler: (req, res) => {
      const retryAfter = resolveRetryAfterSeconds(req, config.windowMs);
      const logLevel = process.env.NODE_ENV === 'production' ? 'error' : 'warn';
      logger[logLevel](`Rate limit exceeded (${type}): ${req.ip} - ${req.method} ${req.path}`, {
        retryAfter,
        limit: req?.rateLimit?.limit,
        used: req?.rateLimit?.used
      });

      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({
        success: false,
        error: 'Too Many Requests',
        message: config.message,
        retryAfter,
        timestamp: new Date().toISOString()
      });
    }
  });
};

const limiters = {
  products: createRateLimiter('publicRead', ['/health', '/api/health']),
  categories: createRateLimiter('publicRead', ['/health', '/api/health']),
  search: createRateLimiter('search', ['/health', '/api/health']),
  write: createRateLimiter('write', ['/health', '/api/health']),
  cartWrite: createRateLimiter('cartWrite', ['/health', '/api/health']),
  couponWrite: createRateLimiter('couponWrite', ['/health', '/api/health']),
  checkoutQuote: createRateLimiter('checkoutQuote', ['/health', '/api/health']),
  checkoutConfirm: createRateLimiter('checkoutConfirm', ['/health', '/api/health']),
  sensitive: createRateLimiter('sensitive', ['/health', '/api/health']),
  orders: createRateLimiter('orders', ['/health', '/api/health']),
  admin: createRateLimiter('admin', ['/health', '/api/health']),
  pushWrite: createRateLimiter('pushWrite', ['/health', '/api/health'])
};

module.exports = { limiters, createRateLimiter, rateLimits };
