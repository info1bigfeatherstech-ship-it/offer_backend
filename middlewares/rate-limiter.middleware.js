const rateLimit = require('express-rate-limit');
const logger = require('../utils/logger');

function resolveRateLimitKey(req, type) {
  const userId = req?.user?._id || req?.user?.id || null;
  if (userId) {
    return `${type}:user:${String(userId)}`;
  }
  return `${type}:ip:${req.ip}`;
}

// Different limits for different endpoints (Industry standard)
const rateLimits = {
  // Public read operations - HIGH limit (products, categories)
  publicRead: {
    windowMs: 15 * 60 * 1000,
    max: 1000,
    message: 'Too many requests, please slow down'
  },
  
  // Search operations - MEDIUM limit
  search: {
    windowMs: 15 * 60 * 1000,
    max: 200,
    message: 'Search limit exceeded, please wait'
  },
  
  // Write operations - LOW limit (cart, wishlist, addresses)
  write: {
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: 'Too many write operations'
  },

  // Cart updates can be frequent due to +/- controls.
  cartWrite: {
    windowMs: 15 * 60 * 1000,
    max: 180,
    message: 'Too many cart operations. Please slow down'
  },

  // Coupon validation/apply should be isolated from cart/checkout writes.
  couponWrite: {
    windowMs: 15 * 60 * 1000,
    max: 80,
    message: 'Too many coupon operations. Please wait and try again'
  },

  // Checkout quote is compute-heavy and should have its own bucket.
  checkoutQuote: {
    windowMs: 15 * 60 * 1000,
    max: 60,
    message: 'Too many checkout quote requests. Please wait a moment'
  },

  // Confirm endpoint is sensitive and should stay stricter than quote.
  checkoutConfirm: {
    windowMs: 15 * 60 * 1000,
    max: 40,
    message: 'Too many checkout confirmation attempts. Please retry shortly'
  },
  
  // Sensitive operations - VERY LOW limit (auth endpoints only — see index.js)
  sensitive: {
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: 'Too many attempts, please try later'
  },

  /**
   * Authenticated order APIs (list, detail, pay, verify, cancel).
   * Must be higher than `sensitive`: a single My Orders session can issue many GETs + payment retries.
   */
  orders: {
    windowMs: 15 * 60 * 1000,
    max: 400,
    message: 'Too many order requests, please wait a moment'
  },
  
  // Admin operations - MEDIUM limit
  admin: {
    windowMs: 15 * 60 * 1000,
    max: 500,
    message: 'Admin rate limit exceeded'
  }
};

// Factory function to create rate limiters
const createRateLimiter = (type, skipPaths = []) => {
  const config = rateLimits[type];
  if (!config) throw new Error(`Invalid rate limit type: ${type}`);
  
  return rateLimit({
    windowMs: config.windowMs,
    max: config.max,
    skip: (req) => skipPaths.includes(req.path),
    keyGenerator: (req) => resolveRateLimitKey(req, type),
    // Prefer user-scoped limiting when authenticated; fallback to client IP.
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      const logLevel = process.env.NODE_ENV === 'production' ? 'error' : 'warn';
      logger[logLevel](`Rate limit exceeded (${type}): ${req.ip} - ${req.method} ${req.path}`);
      
      res.status(429).json({
        success: false,
        error: 'Too Many Requests',
        message: config.message,
        retryAfter: Math.ceil(config.windowMs / 1000),
        timestamp: new Date().toISOString()
      });
    }
  });
};

// Pre-configured limiters
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
  admin: createRateLimiter('admin', ['/health', '/api/health'])
};

module.exports = { limiters, createRateLimiter };