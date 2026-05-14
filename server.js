/**
 * server.js
 * ---------
 * Builds the Express app, mounts all middleware/routes, and exposes
 * `startApplication` for `index.js` to call. No side-effects at module load
 * other than building the app instance.
 *
 * Entry point remains `index.js` (it loads dotenv first and then calls
 * `startApplication` from this module).
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const express = require('express');
const mongoose = require('mongoose');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const Sentry = require('@sentry/node');

// Config / services
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

// Middleware
const { optionalAuth } = require('./middlewares/user-type-optional.middleware');
const { resolveStorefrontMiddleware } = require('./middlewares/storefront.middleware');
const { limiters } = require('./middlewares/rate-limiter.middleware');
const { mongoSanitizeMiddleware } = require('./utils/mongoSanitize');

// Routes (ACTIVE ONLY)
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
const productReviewPublicRoutes = require('./routes/product-review.public.route');
const productReviewUserRoutes = require('./routes/product-review.user.route');
const adminProductReviewRoutes = require('./routes/admin-product-review.route');

// ============================================================================
// Configuration
// ============================================================================

const PORT = Number(process.env.PORT) || 8081;
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';

const FIRST_ORDER_COUPON_CODE = 'WELC01';

// PM2 cluster sets NODE_APP_INSTANCE to '0','1',... Direct node run leaves it
// undefined. Schedulers must only run on one process to avoid duplicate work.
const IS_PRIMARY_INSTANCE =
  process.env.NODE_APP_INSTANCE === undefined ||
  process.env.NODE_APP_INSTANCE === '0';

const app = express();
let server = null;
let healthMonitorInterval = null;

// ============================================================================
// On-disk runtime directories (logs, uploads, temp) -- create eagerly so PM2,
// multer, and shutdown cleanup never ENOENT on first start.
// ============================================================================

for (const dir of ['logs', 'uploads', 'temp']) {
  const abs = path.join(__dirname, dir);
  try {
    if (!fs.existsSync(abs)) {
      fs.mkdirSync(abs, { recursive: true });
    }
  } catch (err) {
    // Non-fatal: the app can still boot; individual subsystems will surface
    // a clearer error if they actually need the directory.
    // eslint-disable-next-line no-console
    console.warn(`[Bootstrap] Failed to ensure directory ${abs}: ${err.message}`);
  }
}

// ============================================================================
// Helpers
// ============================================================================

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

function parseOriginsCsv(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter((s) => {
      if (!s) return false;
      try {
        // Reject malformed origins (e.g. typos with unicode ellipsis).
        const u = new URL(s);
        return Boolean(u.protocol && u.host);
      } catch {
        logger.warn('[Config] Ignoring malformed CORS origin', { value: s });
        return false;
      }
    });
}

function resolveTrustProxySetting() {
  const raw = String(process.env.EXPRESS_TRUST_PROXY || '').trim();
  if (!raw) {
    return IS_PRODUCTION ? 1 : false;
  }

  const normalized = raw.toLowerCase();
  if (['true', 'yes', 'on'].includes(normalized)) return true;
  if (['false', 'no', 'off'].includes(normalized)) return false;
  if (normalized === 'loopback' || normalized === 'linklocal' || normalized === 'uniquelocal') {
    return normalized;
  }
  if (/^\d+$/.test(normalized)) {
    return Number.parseInt(normalized, 10);
  }
  if (raw.includes(',')) {
    return raw.split(',').map((part) => part.trim()).filter(Boolean);
  }
  return raw;
}

function validateStartupConfig() {
  const warnings = [];
  const errors = [];

  const jwtSecret = String(process.env.JWT_SECRET || '').trim();
  const refreshSecret = String(process.env.REFRESH_TOKEN_SECRET || '').trim();
  const ownerReviewSecret = String(process.env.OWNER_REVIEW_JWT_SECRET || '').trim();
  const mongoUri = String(process.env.MONGO_DB_URI || process.env.MONGO_URI || '').trim();
  const razorpayKeyId = String(process.env.RAZORPAY_KEY_ID || '').trim();
  const razorpayKeySecret = String(process.env.RAZORPAY_KEY_SECRET || '').trim();
  const webhookSecret = String(process.env.RAZORPAY_WEBHOOK_SECRET || '').trim();
  const cookieDomain = String(process.env.COOKIE_DOMAIN || '').trim();
  const corsAllowedOrigins = parseOriginsCsv(process.env.CORS_ALLOWED_ORIGINS);
  const ownerReviewOrigins = parseOriginsCsv(process.env.OWNER_REVIEW_ALLOWED_ORIGINS);
  const demoMockShippingEnabled = parseBoolEnv(process.env.ALLOW_DEMO_MOCK_SHIPPING);
  const mediaMode = String(process.env.MEDIA_STORAGE_MODE || '').trim().toLowerCase();
  const defaultMediaProvider = String(process.env.MEDIA_PROVIDER_DEFAULT || '').trim().toLowerCase();
  const returnMediaProvider = String(process.env.MEDIA_PROVIDER_RETURNS || '').trim().toLowerCase();

  if (!jwtSecret) errors.push('JWT_SECRET is required');
  if (!refreshSecret) errors.push('REFRESH_TOKEN_SECRET is required');
  if (!mongoUri) errors.push('MONGO_DB_URI (or MONGO_URI) is required');

  // Detect weak/duplicate secrets in production.
  if (IS_PRODUCTION) {
    if (jwtSecret && jwtSecret.length < 32) {
      warnings.push('JWT_SECRET is shorter than 32 chars; regenerate with crypto.randomBytes(64).');
    }
    if (refreshSecret && refreshSecret.length < 32) {
      warnings.push('REFRESH_TOKEN_SECRET is shorter than 32 chars; regenerate with crypto.randomBytes(64).');
    }
    if (ownerReviewSecret && ownerReviewSecret === jwtSecret) {
      warnings.push('OWNER_REVIEW_JWT_SECRET equals JWT_SECRET; use a distinct value.');
    }
    if (!cookieDomain) {
      warnings.push('COOKIE_DOMAIN is not set in production; cross-subdomain cookie behavior may be inconsistent.');
    }
    if (corsAllowedOrigins.length === 0) {
      warnings.push('CORS_ALLOWED_ORIGINS is empty in production; every browser frontend will be blocked.');
    }
    if (!razorpayKeyId || !razorpayKeySecret) {
      warnings.push('RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET missing; online payment flows will fail.');
    } else if (razorpayKeyId.startsWith('rzp_test_')) {
      warnings.push('RAZORPAY_KEY_ID is a TEST key in production; real payments will not work.');
    }
    if (!webhookSecret) {
      warnings.push('RAZORPAY_WEBHOOK_SECRET missing; webhook signature verification cannot be enforced.');
    }
    if (demoMockShippingEnabled) {
      warnings.push('ALLOW_DEMO_MOCK_SHIPPING is enabled in production; disable it.');
    }
  }

  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
    warnings.push('EMAIL_USER or EMAIL_PASSWORD missing; OTP/email workflows may fail.');
  }

  if (ownerReviewOrigins.length === 0) {
    warnings.push('OWNER_REVIEW_ALLOWED_ORIGINS not configured; owner review relies on default origins.');
  }

  const shiprocketEnabled = String(process.env.SHIPROCKET_ENABLED || '').toLowerCase() === 'true';
  if (shiprocketEnabled) {
    const pickupNickname = String(
      process.env.SHIPROCKET_PICKUP_LOCATION || process.env.PICKUP_LOCATION_NICKNAME || ''
    ).trim();
    if (!pickupNickname) {
      warnings.push(
        'SHIPROCKET_ENABLED=true but SHIPROCKET_PICKUP_LOCATION (or PICKUP_LOCATION_NICKNAME) is empty — forward shipment create will fail until you set the pickup address nickname from Shiprocket (Company → Pick Up Addresses) and restart the API.'
      );
    }
    if (!String(process.env.SHIPROCKET_EMAIL || '').trim() || !String(process.env.SHIPROCKET_PASSWORD || '').trim()) {
      warnings.push('SHIPROCKET_EMAIL or SHIPROCKET_PASSWORD missing; Shiprocket login will fail.');
    }
  }

  const resolvedDefaultProvider = defaultMediaProvider || (mediaMode === 'hybrid' ? 'r2' : 'cloudinary');
  const resolvedReturnProvider = returnMediaProvider || (mediaMode === 'hybrid' ? 'cloudinary' : resolvedDefaultProvider);

  if (resolvedDefaultProvider === 'r2') {
    const requiredR2Vars = [
      'R2_BUCKET_NAME',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
      'R2_ENDPOINT',
      'R2_PUBLIC_BASE_URL'
    ];
    for (const key of requiredR2Vars) {
      if (!String(process.env[key] || '').trim()) {
        errors.push(`${key} is required when MEDIA_PROVIDER_DEFAULT resolves to r2`);
      }
    }
  }

  if (resolvedReturnProvider === 'cloudinary') {
    const requiredCloudinaryVars = [
      'CLOUDINARY_CLOUD_NAME',
      'CLOUDINARY_API_KEY',
      'CLOUDINARY_API_SECRET'
    ];
    for (const key of requiredCloudinaryVars) {
      if (!String(process.env[key] || '').trim()) {
        errors.push(`${key} is required when MEDIA_PROVIDER_RETURNS resolves to cloudinary`);
      }
    }
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
// Origin allowlists (computed once at boot)
// ============================================================================

// Same host as this API (e.g. /checkout-demo.html) -- browsers still send
// Origin on POST; must be allowed when serving the static demo pages.
const sameServerOrigins = [
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`
];

// Localhost browser origins are auto-allowed only in non-production.
const devLocalhostOrigins = !IS_PRODUCTION
  ? [
      'http://localhost:3000',
      'http://localhost:5173',
      'http://localhost:5174',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:5173'
    ]
  : [];

const envAllowedOrigins = parseOriginsCsv(process.env.CORS_ALLOWED_ORIGINS);
const allowedOrigins = new Set([
  ...devLocalhostOrigins,
  ...sameServerOrigins,
  ...envAllowedOrigins
]);

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

// ============================================================================
// Security & Middleware Setup
// ============================================================================

const trustProxySetting = resolveTrustProxySetting();
app.set('trust proxy', trustProxySetting);
logger.info('[Config] Express trust proxy configured', { trustProxy: trustProxySetting });

// Razorpay netbanking/card flows POST to bank URLs and embed bank frames --
// Helmet's default form-action/frame-src are too tight.
const razorpayCspHosts = [
  'https://api.razorpay.com',
  'https://checkout.razorpay.com',
  'https://*.razorpay.com',
  'https://cdn.razorpay.com'
];

// R2 public base URL needs to be allowed in imgSrc when server-rendered HTML
// (templates/wholesaler-owner-review.html, dashboards) references R2 media.
const r2PublicBaseForCsp = String(process.env.R2_PUBLIC_BASE_URL || '')
  .trim()
  .replace(/\/$/, '');

const imgSrcAllowList = [
  "'self'",
  'data:',
  'blob:',
  'https://res.cloudinary.com',
  'https://cdn.razorpay.com'
];
if (r2PublicBaseForCsp) {
  imgSrcAllowList.push(r2PublicBaseForCsp);
}

app.use(helmet({
  // Default COOP is `same-origin`, which breaks Razorpay netbanking/card popups.
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'", 'https://checkout.razorpay.com', ...razorpayCspHosts],
      connectSrc: ["'self'", 'wss://*.razorpay.com', ...razorpayCspHosts],
      frameSrc: ["'self'", ...razorpayCspHosts, 'https:'],
      formAction: ["'self'", ...razorpayCspHosts, 'https:'],
      imgSrc: imgSrcAllowList
    }
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
      // Allow requests with no origin (mobile apps, curl, server-to-server).
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
      // Any other same-machine origin on the API port.
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

// Razorpay webhooks must use raw body for signature verification (before express.json).
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
app.use(morgan(IS_PRODUCTION ? 'combined' : 'dev'));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use(resolveStorefrontMiddleware);

// Global optional auth (sets req.userType / req.userId when token present).
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

app.use((req, res, next) => {
  const incomingId = sanitizeIncomingRequestId(req.headers['x-request-id']);
  req.id = incomingId || buildRequestId();
  res.setHeader('X-Request-ID', req.id);
  next();
});

// NoSQL injection defense: strip Mongo operator keys ($ne, $gt, etc.) and
// dotted keys from body/params/query before any route handler can see them.
// Mounted after request-id so any sanitization events are correlated.
app.use(mongoSanitizeMiddleware());

function setOperationalNoCacheHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

// ============================================================================
// Rate limiting
// ============================================================================

app.use('/api/products', limiters.products);
app.use('/api/categories', limiters.categories);
app.use('/api/products/search', limiters.search);
app.use('/api/cart', limiters.cartWrite);
app.use('/api/wishlist', limiters.write);
app.use('/api/addresses', limiters.write);
app.use('/api/delivery', limiters.write);
app.use('/api/checkout/quote', limiters.checkoutQuote);
app.use('/api/checkout/confirm', limiters.checkoutConfirm);
app.use('/api/coupons', limiters.couponWrite);

app.use('/api/auth/login', limiters.sensitive);
app.use('/api/auth/register', limiters.sensitive);
app.use('/api/auth/otp-verify-login', limiters.sensitive);
app.use('/api/auth/forgot-password', limiters.sensitive);
app.use('/api/auth/change-password', limiters.sensitive);
app.use('/api/wholesaler/request', limiters.sensitive);
app.use('/api/wholesaler/activate/send-otp', limiters.sensitive);
app.use('/api/wholesaler/activate/verify', limiters.sensitive);
app.use('/api/wholesaler/owner-review', limiters.sensitive);

// Orders: dedicated bucket (the `sensitive` cap blocked normal My Orders flow).
app.use('/api/orders', limiters.orders);
app.use('/api/admin', limiters.admin);

// ============================================================================
// Health Check Endpoints (no rate limit)
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
    if (mongoose.connection.readyState === 1) {
      healthStatus.services.mongodb = 'connected';
    } else {
      healthStatus.services.mongodb = 'disconnected';
      healthStatus.status = 'degraded';
    }

    if (redisManager.isReady()) {
      await redisManager.getClient().ping();
      healthStatus.services.redis = 'connected';
    } else {
      healthStatus.services.redis = 'disconnected';
      if (IS_PRODUCTION) {
        healthStatus.status = 'degraded';
      }
    }

    const memUsage = process.memoryUsage();
    healthStatus.services.memory = {
      rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`,
      heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
      heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
      external: `${Math.round(memUsage.external / 1024 / 1024)}MB`
    };

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

  if (!redisManager.isReady() && IS_PRODUCTION) {
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
    keyId
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

// ============================================================================
// API Info / Routes
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
      coupons: '/api/coupons',
      productReviewsPublic: '/api/product-reviews/public/:productId',
      productReviews: '/api/product-reviews',
      adminProductReviews: '/api/admin/product-reviews'
    },
    health: '/health',
    cacheStats: '/api/cache/stats'
  });
});

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
app.use('/api/product-reviews/public', limiters.products, productReviewPublicRoutes);
app.use('/api/product-reviews', limiters.write, productReviewUserRoutes);
app.use('/api/admin/product-reviews', limiters.admin, adminProductReviewRoutes);
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

// Sentry's Express error handler runs BEFORE the custom JSON error handler so
// Sentry receives the unhandled error first, then our handler shapes the
// response for the client. setupExpressErrorHandler is a no-op when Sentry
// was not initialised (no DSN), so this is safe to mount unconditionally.
Sentry.setupExpressErrorHandler(app);

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error(`[Error] ${err.message}`, {
    stack: err.stack,
    path: req.path,
    method: req.method,
    requestId: req.id
  });

  const statusCode = err.statusCode || 500;
  const message = IS_PRODUCTION && statusCode === 500
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
    if (process.env.NODE_APP_INSTANCE !== undefined) {
      logger.info(`PM2 cluster worker index: ${process.env.NODE_APP_INSTANCE}`);
    }
    validateStartupConfig();

    // Initialize services
    initCloudinary();
    await connectMongoDB();
    setupMongoDBEventHandlers();

    // Connect to Redis (non-blocking in non-prod; bubbled up in prod by redis.config).
    try {
      await redisManager.connect();
      logger.info('[Redis] Connected successfully');

      const cacheService = require('./services/cache.service');
      logger.info('[Cache] Service ready', cacheService.getStats());
    } catch (error) {
      logger.error(`[Redis] Connection failed: ${error.message}`, { stack: error.stack });
      logger.warn('[Redis] Running without Redis cache - functionality may be limited');
    }

    // Schedulers must only run on ONE process to avoid duplicate sweeps in
    // PM2 cluster mode. When run directly with `node`, IS_PRIMARY_INSTANCE is
    // also true, so behaviour is unchanged for single-process deployments.
    if (IS_PRIMARY_INSTANCE) {
      cleanupService.start();
      paymentHoldExpiryService.start();
      logger.info('[Schedulers] cleanup + paymentHold started on primary instance');
    } else {
      logger.info('[Schedulers] Skipping cleanup/paymentHold on secondary worker', {
        instance: process.env.NODE_APP_INSTANCE
      });
    }

    server = app.listen(PORT, () => {
      const publicBase = String(process.env.PUBLIC_API_BASE_URL || process.env.API_PUBLIC_BASE_URL || `http://localhost:${PORT}`)
        .trim()
        .replace(/\/$/, '');
      logger.info('='.repeat(70));
      logger.info(`✓ Server running on port ${PORT} (${NODE_ENV})`);
      logger.info(`✓ API Base URL: ${publicBase}/api`);
      logger.info(`✓ Health Check: ${publicBase}/health`);
      logger.info(`✓ Cache Stats: ${publicBase}/api/cache/stats`);
      logger.info('='.repeat(70));
    });

    gracefulShutdown.registerServer(server);

    gracefulShutdown.registerConnection('MongoDB', async () => {
      if (mongoose.connection.readyState === 1) {
        await mongoose.connection.close(false);
      }
    });

    gracefulShutdown.registerConnection('Redis', async () => {
      await redisManager.disconnect();
    });

    if (IS_PRIMARY_INSTANCE) {
      gracefulShutdown.registerConnection('CleanupService', async () => {
        cleanupService.stop();
      });

      gracefulShutdown.registerConnection('PaymentHoldExpiryService', async () => {
        paymentHoldExpiryService.stop();
      });
    }

    gracefulShutdown.registerConnection('HealthMonitor', async () => {
      if (healthMonitorInterval) {
        clearInterval(healthMonitorInterval);
        healthMonitorInterval = null;
      }
    });

    gracefulShutdown.setupProcessHandlers();

    startHealthMonitoring();
  } catch (error) {
    logger.error(`Startup failed: ${error.message}`);
    if (error.stack) logger.error(error.stack);
    process.exit(1);
  }
}

function startHealthMonitoring() {
  // Cleared during graceful shutdown via the HealthMonitor connection.
  healthMonitorInterval = setInterval(() => {
    const memUsage = process.memoryUsage();
    const rssMB = Math.round(memUsage.rss / 1024 / 1024);

    if (rssMB > 500 && IS_PRODUCTION) {
      logger.warn(`[Health] High memory usage: ${rssMB}MB`);
    }

    logger.debug(`[Health] Memory: ${rssMB}MB | Connections: ${server?.connections || 0}`);
  }, 30000);

  if (typeof healthMonitorInterval.unref === 'function') {
    healthMonitorInterval.unref();
  }
}

module.exports = {
  app,
  startApplication,
  gracefulShutdown
};
