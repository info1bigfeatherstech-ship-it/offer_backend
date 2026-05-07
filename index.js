const express = require('express');
const mongoose = require('mongoose');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
require('dotenv').config();

// Import services
const { connectMongoDB, setupMongoDBEventHandlers } = require('./config/database.config');
const redisManager = require('./config/redis.config');
const { initCloudinary } = require('./config/cloudinary.config');
const gracefulShutdown = require('./services/shutdown.service');
const cleanupService = require('./services/cleanup.service');
const paymentHoldExpiryService = require('./services/paymentHoldExpiry.service');
const logger = require('./utils/logger');
const { CORS_STOREFRONT_ALLOWED_HEADERS } = require('./constants/storefrontHeaders');
const Coupon = require('./models/Coupon');
const Order = require('./models/Order');

// Import middleware
const { optionalAuth } = require('./middlewares/user-type-optional.middleware');
const { resolveStorefrontMiddleware } = require('./middlewares/storefront.middleware');
const { limiters } = require('./middlewares/rate-limiter.middleware');

// Import routes (ACTIVE ONLY)
const authRoutes = require('./routes/auth.route');
const adminProductsRoutes = require('./routes/admin-products.route');
const categoriesRoutes = require('./routes/categories.route');
const productsRoutes = require('./routes/products.route');
const wishlistRoutes = require('./routes/wishlist.route');
const cartRoutes = require('./routes/cart.route');
const addressRoutes = require('./routes/address.route');
const adminAnalyticsRoutes = require('./routes/admin-analytics.route');
const adminOrdersRoutes = require('./routes/admin-orders.route');
const staffRoutes = require('./routes/staff.route');
const orderRoutes = require('./routes/orders.route');
const orderController = require('./controllers/order.controller');
const deliveryRoutes = require('./routes/delivery.route');
const checkoutRoutes = require('./routes/checkout.route');
const adminCouponRoutes = require('./routes/admin-coupons.route');
const userCouponRoutes = require('./routes/user-coupons.route');
const wholesalerRoutes = require('./routes/wholesaler.route');

// Configuration
const PORT = process.env.PORT || 8081;
const NODE_ENV = process.env.NODE_ENV || 'development';

const app = express();
let server = null;
const FIRST_ORDER_COUPON_CODE = 'WELC01';

const normalizeCouponCode = (code) => String(code || '').trim().toUpperCase();
const isFirstOrderCoupon = (coupon) => normalizeCouponCode(coupon?.code) === FIRST_ORDER_COUPON_CODE;

async function hasPlacedAnyOrder(userId) {
  if (!userId) return false;
  const placedOrderCount = await Order.countDocuments({
    userId,
    orderStatus: { $ne: 'payment_failed' }
  });
  return placedOrderCount > 0;
}

function parseBoolEnv(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function validateStartupConfig() {
  const warnings = [];
  const errors = [];
  const isProd = NODE_ENV === 'production';

  const jwtSecret = String(process.env.JWT_SECRET || '').trim();
  const refreshSecret = String(process.env.REFRESH_TOKEN_SECRET || '').trim();
  const mongoUri = String(process.env.MONGO_DB_URI || process.env.MONGO_URI || '').trim();
  const razorpayKeyId = String(process.env.RAZORPAY_KEY_ID || '').trim();
  const razorpayKeySecret = String(process.env.RAZORPAY_KEY_SECRET || '').trim();
  const webhookSecret = String(process.env.RAZORPAY_WEBHOOK_SECRET || '').trim();
  const cookieDomain = String(process.env.COOKIE_DOMAIN || '').trim();
  const corsAllowedOrigins = parseOriginsCsv(process.env.CORS_ALLOWED_ORIGINS);
  const ownerReviewOrigins = parseOriginsCsv(process.env.OWNER_REVIEW_ALLOWED_ORIGINS);
  const demoMockShippingEnabled = parseBoolEnv(process.env.ALLOW_DEMO_MOCK_SHIPPING);

  if (!jwtSecret) errors.push('JWT_SECRET is required');
  if (!refreshSecret) errors.push('REFRESH_TOKEN_SECRET is required');
  if (!mongoUri) errors.push('MONGO_DB_URI (or MONGO_URI) is required');

  if (isProd) {
    if (!cookieDomain) {
      warnings.push('COOKIE_DOMAIN is not set in production; cross-subdomain cookie behavior may be inconsistent');
    }
    if (corsAllowedOrigins.length === 0) {
      warnings.push('CORS_ALLOWED_ORIGINS is empty in production; verify allowed origin defaults match deployment frontends');
    }
    if (!razorpayKeyId || !razorpayKeySecret) {
      warnings.push('RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET missing; online payment flows will fail');
    }
    if (!webhookSecret) {
      warnings.push('RAZORPAY_WEBHOOK_SECRET missing; webhook signature verification cannot be enforced');
    }
    if (demoMockShippingEnabled) {
      warnings.push('ALLOW_DEMO_MOCK_SHIPPING is enabled in production; this should normally be disabled');
    }
  }

  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
    warnings.push('EMAIL_USER or EMAIL_PASSWORD missing; OTP/email workflows may fail');
  }

  if (ownerReviewOrigins.length === 0) {
    warnings.push('OWNER_REVIEW_ALLOWED_ORIGINS not configured; owner review access relies only on default origin set');
  }

  if (errors.length) {
    for (const issue of errors) {
      logger.error(`[Config] ${issue}`);
    }
    throw new Error('Startup configuration validation failed');
  }

  for (const issue of warnings) {
    logger.warn(`[Config] ${issue}`);
  }
}

// ============================================================================
// Security & Middleware Setup
// ============================================================================
// Same host as this API (e.g. /checkout-demo.html) — browsers still send Origin on POST; must be allowed.
const sameServerOrigins = [
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`
];
const defaultAllowedOrigins = [
  'https://offerwaalebaba.netlify.app',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5173',
  ...sameServerOrigins
];

function parseOriginsCsv(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

const envAllowedOrigins = parseOriginsCsv(process.env.CORS_ALLOWED_ORIGINS);
const allowedOrigins = new Set([...defaultAllowedOrigins, ...envAllowedOrigins]);

const publicApiBase = String(process.env.PUBLIC_API_BASE_URL || process.env.API_PUBLIC_BASE_URL || '')
  .trim()
  .replace(/\/$/, '');
const ownerReviewAllowedOrigins = new Set([
  ...allowedOrigins,
  ...parseOriginsCsv(process.env.OWNER_REVIEW_ALLOWED_ORIGINS),
  ...(publicApiBase ? [publicApiBase] : [])
]);

function isLoopbackOriginOnApiPort(origin) {
  try {
    const u = new URL(origin);
    return (
      (u.hostname === 'localhost' || u.hostname === '127.0.0.1') &&
      u.port === String(PORT)
    );
  } catch (_) {
    return false;
  }
}

// Razorpay netbanking/card flows POST to bank URLs and embed bank frames — Helmet's default
// form-action/frame-src are too tight (often only 'self'), which can leave a popup on about:blank.
const razorpayCspHosts = [
  'https://api.razorpay.com',
  'https://checkout.razorpay.com',
  'https://*.razorpay.com',
  'https://cdn.razorpay.com'
];

app.use(helmet({
  // Default COOP is `same-origin`, which breaks Razorpay netbanking/card popups
  // (cross-origin window stays on about:blank / checkout fails). See helmet README.
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'", 'https://checkout.razorpay.com', ...razorpayCspHosts],
      connectSrc: ["'self'", 'wss://*.razorpay.com', ...razorpayCspHosts],
      frameSrc: ["'self'", ...razorpayCspHosts, 'https:'],
      formAction: ["'self'", ...razorpayCspHosts, 'https:'],
      imgSrc: ["'self'", 'https://res.cloudinary.com', 'https://cdn.razorpay.com', 'data:'],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
}));

app.use((req, res, next) => {
  // Owner review is token-protected, but CORS still remains strict and configurable.
  const isOwnerReviewPath = req.path.startsWith('/api/wholesaler/owner-review');

  const corsOptions = {
    origin(origin, callback) {
      // Allow requests with no origin (like mobile apps or curl)
      if (!origin) return callback(null, true);
      if (
        isOwnerReviewPath &&
        (
          ownerReviewAllowedOrigins.has(origin) ||
          origin === 'null' || // opaque origins (some in-app browsers/webviews)
          isLoopbackOriginOnApiPort(origin)
        )
      ) {
        return callback(null, true);
      }
      if (!isOwnerReviewPath && allowedOrigins.has(origin)) {
        return callback(null, true);
      }
      // Any other same-machine origin on the API port (PORT in .env)
      if (isLoopbackOriginOnApiPort(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Not allowed by CORS'));
    },
    credentials: !isOwnerReviewPath, // no cookies needed for token-based owner review
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', ...CORS_STOREFRONT_ALLOWED_HEADERS]
  };

  return cors(corsOptions)(req, res, next);
});




// Razorpay webhooks must use raw body for signature verification (before express.json)
app.post(
  '/api/orders/payment/webhook',
  express.raw({ type: 'application/json' }),
  orderController.razorpayWebhook
);

app.post(
  '/api/orders/shipping/webhook',
  express.json({ limit: '1mb' }),
  orderController.shiprocketWebhook
);


app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(morgan(NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use(resolveStorefrontMiddleware);

// ✅ Apply userType middleware (GLOBAL - for all routes)
app.use(optionalAuth);

function buildRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}`;
}

function sanitizeIncomingRequestId(value) {
  const candidate = String(value || '').trim();
  if (!candidate) return '';
  if (candidate.length > 128) return '';
  return /^[A-Za-z0-9._:-]+$/.test(candidate) ? candidate : '';
}

// Request ID middleware (honors trusted inbound ID, otherwise generates one)
app.use((req, res, next) => {
  const incomingId = sanitizeIncomingRequestId(req.headers['x-request-id']);
  req.id = incomingId || buildRequestId();
  res.setHeader('X-Request-ID', req.id);
  next();
});

function setOperationalNoCacheHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

// ============================================================================
// RATE LIMITING (Different limits for different routes)
// ============================================================================

// Public read operations - HIGH limit (products, categories)
app.use('/api/products', limiters.products);
app.use('/api/categories', limiters.categories);

// Search - MEDIUM limit
app.use('/api/products/search', limiters.search);

// Write operations - LOW limit (cart, wishlist, addresses)
app.use('/api/cart', limiters.write);
app.use('/api/wishlist', limiters.write);
app.use('/api/addresses', limiters.write);
app.use('/api/delivery', limiters.write);
app.use('/api/checkout', limiters.write);
app.use('/api/coupons', limiters.write);

// Sensitive operations - VERY LOW limit (auth)
app.use('/api/auth/login', limiters.sensitive);
app.use('/api/auth/register', limiters.sensitive);
app.use('/api/auth/otp-verify-login', limiters.sensitive);
app.use('/api/auth/forgot-password', limiters.sensitive);
app.use('/api/auth/change-password', limiters.sensitive);
app.use('/api/wholesaler/request', limiters.sensitive);
app.use('/api/wholesaler/activate/send-otp', limiters.sensitive);
app.use('/api/wholesaler/activate/verify', limiters.sensitive);
app.use('/api/wholesaler/owner-review', limiters.sensitive);
// Orders: own bucket (not `sensitive` — that 20/15m cap blocked normal My Orders + payment retries)
app.use('/api/orders', limiters.orders);

// Admin operations - MEDIUM limit
app.use('/api/admin', limiters.admin);

// ============================================================================
// Health Check Endpoints (No rate limit)
// ============================================================================

app.get('/health', async (req, res) => {
  setOperationalNoCacheHeaders(res);
  const healthStatus = {
    success: true,
    code: 'SERVICE_HEALTH_STATUS',
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    requestId: req.id,
    environment: NODE_ENV,
    services: {
      mongodb: 'unknown',
      redis: 'unknown',
      memory: 'unknown'
    }
  };

  try {
    // MongoDB check
    if (mongoose.connection.readyState === 1) {
      healthStatus.services.mongodb = 'connected';
    } else {
      healthStatus.services.mongodb = 'disconnected';
      healthStatus.status = 'degraded';
    }

    // Redis check
    if (redisManager.isReady()) {
      await redisManager.getClient().ping();
      healthStatus.services.redis = 'connected';
    } else {
      healthStatus.services.redis = 'disconnected';
      if (NODE_ENV === 'production') {
        healthStatus.status = 'degraded';
      }
    }

    // Memory check
    const memUsage = process.memoryUsage();
    healthStatus.services.memory = {
      rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`,
      heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
      heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
      external: `${Math.round(memUsage.external / 1024 / 1024)}MB`
    };

    // Cache stats
    const cacheService = require('./services/cache.service');
    healthStatus.cache = cacheService.getStats();

    const statusCode = healthStatus.status === 'healthy' ? 200 : 503;
    if (statusCode !== 200) {
      healthStatus.code = 'SERVICE_HEALTH_DEGRADED';
    }
    res.status(statusCode).json(healthStatus);
  } catch (error) {
    healthStatus.success = false;
    healthStatus.code = 'SERVICE_HEALTH_CHECK_FAILED';
    healthStatus.status = 'unhealthy';
    healthStatus.error = error.message;
    res.status(503).json(healthStatus);
  }
});

app.get('/health/ready', async (req, res) => {
  setOperationalNoCacheHeaders(res);
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({
      success: false,
      code: 'SERVICE_NOT_READY',
      status: 'not_ready',
      reason: 'database_not_connected',
      requestId: req.id
    });
  }

  if (!redisManager.isReady() && NODE_ENV === 'production') {
    return res.status(503).json({
      success: false,
      code: 'SERVICE_NOT_READY',
      status: 'not_ready',
      reason: 'cache_not_connected',
      requestId: req.id
    });
  }

  res.status(200).json({
    success: true,
    code: 'SERVICE_READY',
    status: 'ready',
    timestamp: new Date().toISOString(),
    requestId: req.id
  });
});

app.get('/health/live', (req, res) => {
  setOperationalNoCacheHeaders(res);
  res.status(200).json({
    success: true,
    code: 'SERVICE_ALIVE',
    status: 'alive',
    timestamp: new Date().toISOString(),
    requestId: req.id
  });
});

// Cache stats endpoint (for monitoring)
app.get('/api/cache/stats', async (req, res) => {
  setOperationalNoCacheHeaders(res);
  const cacheService = require('./services/cache.service');
  res.json({
    success: true,
    code: 'CACHE_STATS',
    requestId: req.id,
    stats: cacheService.getStats()
  });
});

/** Public Razorpay key_id for hosted Checkout (never expose key_secret). */
app.get('/api/public/razorpay-key', (req, res) => {
  setOperationalNoCacheHeaders(res);
  const keyId = String(process.env.RAZORPAY_KEY_ID || '').trim();
  if (!keyId) {
    return res.status(503).json({
      success: false,
      code: 'RAZORPAY_KEY_NOT_CONFIGURED',
      requestId: req.id,
      message: 'RAZORPAY_KEY_ID is not set on the server'
    });
  }
  return res.json({
    success: true,
    code: 'RAZORPAY_KEY_OK',
    requestId: req.id,
    keyId: String(keyId).trim()
  });
});

/** Public active coupons for marketing surfaces (PDP/home banners). */
app.get('/api/public/coupons', async (req, res) => {
  try {
    setOperationalNoCacheHeaders(res);
    const now = new Date();
    let coupons = await Coupon.find({
      isActive: true,
      expiryDate: { $gt: now },
      applicableUsers: { $in: ['user'] }
    })
      .sort({ expiryDate: 1, createdAt: -1 })
      .select('code name description discountType discountValue minOrderValue maxDiscountAmount expiryDate')
      .lean();

    const alreadyPlacedOrder = await hasPlacedAnyOrder(req.userId);
    if (alreadyPlacedOrder) {
      coupons = coupons.filter((coupon) => !isFirstOrderCoupon(coupon));
    } else {
      coupons.sort((a, b) => Number(isFirstOrderCoupon(b)) - Number(isFirstOrderCoupon(a)));
    }

    return res.json({
      success: true,
      code: 'PUBLIC_COUPONS_OK',
      requestId: req.id,
      coupons
    });
  } catch (error) {
    logger.error('public coupons fetch failed', { message: error.message, stack: error.stack });
    return res.status(500).json({
      success: false,
      code: 'PUBLIC_COUPONS_FAILED',
      requestId: req.id,
      message: 'Failed to load coupons'
    });
  }
});

// Helper function to get event loop lag
function getEventLoopLag() {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    setImmediate(() => {
      const lag = Number(process.hrtime.bigint() - start) / 1e6;
      resolve(`${Math.round(lag)}ms`);
    });
  });
}

// ============================================================================
// Routes - ONLY ACTIVE ROUTES
// ============================================================================

app.get('/api', (req, res) => {
  setOperationalNoCacheHeaders(res);
  res.json({
    success: true,
    code: 'API_INFO',
    message: 'E-Commerce Platform API v1.0',
    status: 'running',
    requestId: req.id,
    version: '1.0.0',
    environment: NODE_ENV,
    userType: req.userType,
    activeEndpoints: {
      auth: '/api/auth',
      products: '/api/products',
      categories: '/api/categories',
      cart: '/api/cart',
      wishlist: '/api/wishlist',
      addresses: '/api/addresses',
      adminProducts: '/api/admin/products',
      adminAnalytics: '/api/admin/analytics',
      adminOrders: '/api/admin/orders',
       publicRazorpayKey: '/api/public/razorpay-key',
      orders: '/api/orders',
      checkout: '/api/checkout',
      delivery: '/api/delivery',
      coupons: '/api/coupons'
    },
    health: '/health',
    cacheStats: '/api/cache/stats'
  });
});

// ✅ ACTIVE ROUTES
app.use('/api/auth', authRoutes);
app.use('/api/admin/products', adminProductsRoutes);
app.use('/api/categories', categoriesRoutes);
app.use('/api/products', productsRoutes);
app.use('/api/wishlist', wishlistRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/addresses', addressRoutes);
app.use('/api/admin/analytics', adminAnalyticsRoutes);
app.use('/api/admin/orders', adminOrdersRoutes);
app.use('/api/admin/staff', staffRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/checkout', checkoutRoutes);
app.use('/api/delivery', deliveryRoutes);
app.use('/api/admin/coupons', adminCouponRoutes);
app.use('/api/coupons', userCouponRoutes);
app.use('/api/wholesaler', wholesalerRoutes);

// ============================================================================
// Error Handling Middleware
// ============================================================================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    code: 'ROUTE_NOT_FOUND',
    error: 'Not Found',
    message: `Cannot ${req.method} ${req.path}`,
    timestamp: new Date().toISOString(),
    requestId: req.id
  });
});

app.use((err, req, res, next) => {
  logger.error(`[Error] ${err.message}`, { 
    stack: err.stack, 
    path: req.path, 
    method: req.method,
    requestId: req.id 
  });

  const statusCode = err.statusCode || 500;
  const message = NODE_ENV === 'production' && statusCode === 500
    ? 'Internal Server Error'
    : err.message;

  res.status(statusCode).json({
    success: false,
    code: err.code || (statusCode === 500 ? 'INTERNAL_SERVER_ERROR' : 'REQUEST_FAILED'),
    error: err.name || 'Error',
    message,
    timestamp: new Date().toISOString(),
    requestId: req.id
  });
});

// ============================================================================
// Application Startup
// ============================================================================

async function startApplication() {
  try {
    logger.info(`Starting application in ${NODE_ENV} mode`);
    logger.info(`Node Version: ${process.version}`);
    validateStartupConfig();

    // Initialize services
    initCloudinary();
    await connectMongoDB();
    setupMongoDBEventHandlers();

    // Connect to Redis (non-blocking)
    try {
      await redisManager.connect();
      logger.info('[Redis] Connected successfully');
      
      const cacheService = require('./services/cache.service');
      logger.info(`[Cache] Service ready, stats:`, cacheService.getStats());
    } catch (error) {
      logger.error(`[Redis] Connection failed: ${error.message}`, { stack: error.stack });
      logger.warn('[Redis] Running without Redis cache - functionality may be limited');
    }

    // ✅ START CLEANUP SERVICE (after DB connection)
    cleanupService.start();
    paymentHoldExpiryService.start();


    // Create HTTP server
    server = app.listen(PORT, () => {
      logger.info('='.repeat(70));
      logger.info(`✓ Server running on port ${PORT}`);
      logger.info(`✓ API Base URL: http://localhost:${PORT}/api`);
      logger.info(`✓ Health Check: http://localhost:${PORT}/health`);
      logger.info(`✓ Cache Stats: http://localhost:${PORT}/api/cache/stats`);
      logger.info('='.repeat(70));
      logger.info('Press CTRL+C to stop the server\n');
    });

    // Register server with shutdown service
    gracefulShutdown.registerServer(server);

    // Register database connections
    gracefulShutdown.registerConnection('MongoDB', async () => {
      if (mongoose.connection.readyState === 1) {
        await mongoose.connection.close(false);
      }
    });

    gracefulShutdown.registerConnection('Redis', async () => {
      await redisManager.disconnect();
    });


     // ✅ REGISTER CLEANUP SERVICE WITH SHUTDOWN
    gracefulShutdown.registerConnection('CleanupService', async () => {
      cleanupService.stop();
    });

    gracefulShutdown.registerConnection('PaymentHoldExpiryService', async () => {
      paymentHoldExpiryService.stop();
    });

    // Setup process handlers
    gracefulShutdown.setupProcessHandlers();

    // Start health monitoring
    startHealthMonitoring();

  } catch (error) {
    logger.error(`Startup failed: ${error.message}`);
    logger.error(error.stack);
    process.exit(1);
  }
}

function startHealthMonitoring() {
  setInterval(() => {
    const memUsage = process.memoryUsage();
    const rssMB = Math.round(memUsage.rss / 1024 / 1024);
    
    if (rssMB > 500 && NODE_ENV === 'production') {
      logger.warn(`[Health] High memory usage: ${rssMB}MB`);
    }
    
    logger.debug(`[Health] Memory: ${rssMB}MB | Connections: ${server?.connections || 0}`);
  }, 30000);
}

// Start the application
startApplication();

module.exports = { app, gracefulShutdown };




//for wholesaler and e-commerce CORS block replacement must
// const sameServerOrigins = [
//   `http://localhost:${PORT}`,
//   `http://127.0.0.1:${PORT}`
// ];

// // CSV from env
// const envOrigins = String(process.env.ALLOWED_ORIGINS || "")
//   .split(",")
//   .map((o) => o.trim())
//   .filter(Boolean);

// // Optional regex allow (for subdomains etc.)
// const allowedOriginRegex = process.env.ALLOWED_ORIGIN_REGEX
//   ? new RegExp(process.env.ALLOWED_ORIGIN_REGEX)
//   : null;

// // Final allowlist
// const allowedOrigins = [...new Set([...envOrigins, ...sameServerOrigins])];

// app.use(cors({
//   origin: (origin, callback) => {
//     // allow non-browser or same-origin requests without Origin header
//     if (!origin) return callback(null, true);

//     if (allowedOrigins.includes(origin)) {
//       return callback(null, true);
//     }

//     if (allowedOriginRegex && allowedOriginRegex.test(origin)) {
//       return callback(null, true);
//     }

//     return callback(new Error(`CORS blocked for origin: ${origin}`));
//   },
//   credentials: true,
//   methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
//   allowedHeaders: ['Content-Type', 'Authorization']
// }));