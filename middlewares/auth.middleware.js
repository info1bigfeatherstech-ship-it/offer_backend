// middleware/auth.js
const jwt = require('jsonwebtoken');
const redisManager = require('../config/redis.config');
const tokenStore = require('../config/tokenBlacklist');
const User = require('../models/User');
const { normalizeAllowedStorefronts } = require('./admin-storefront-scope.middleware');

const normalizePortalClaim = (rawPortal) => {
  const normalized = String(rawPortal || '').trim().toLowerCase();
  return normalized || null;
};

/**
 * Verify JWT Token Middleware
 * Checks for valid JWT token in Authorization header (Bearer token)
 */
const verifyToken = async (req, res, next) => {
  try {
    // Get token from Authorization header
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({
        success: false,
        message: 'User is not logged in',
        code: 'MISSING_AUTH_HEADER'
      });
    }

    // Extract Bearer token
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : authHeader;

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Token is required',
        code: 'MISSING_TOKEN'
      });
    }

    // Verify token
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET 
    );
    
    if (decoded.type !== 'access') {
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid token type' 
      });
    }

    // Check blacklist (Redis when available; in-memory fallback for single-instance / Redis outage)
    try {
      const redis = redisManager.getRedisClient();
      if (redis) {
        const isBlacklisted = await redis.get(`bl_${token}`);
        if (isBlacklisted) {
          return res.status(401).json({ 
            success: false, 
            message: 'Token is blacklisted', 
            code: 'TOKEN_BLACKLISTED' 
          });
        }
      } else if (tokenStore.has(token)) {
        return res.status(401).json({ 
          success: false, 
          message: 'Token is blacklisted', 
          code: 'TOKEN_BLACKLISTED' 
        });
      }
    } catch (err) {
      if (tokenStore.has(token)) {
        return res.status(401).json({ 
          success: false, 
          message: 'Token is blacklisted', 
          code: 'TOKEN_BLACKLISTED' 
        });
      }
    }

    // Fetch user to get role and userType for RBAC
    const user = await User.findById(decoded.id).select('userType role allowedStorefronts');
    
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'User not found',
        code: 'USER_NOT_FOUND'
      });
    }

    const resolvedRole = user.role || user.userType || 'user';

    req.userId = decoded.id;
    req.userType = user.userType || 'user';
    req.authPortal = normalizePortalClaim(decoded.portal);
    req.user = {
      id: decoded.id,
      role: String(resolvedRole).toLowerCase(),
      allowedStorefronts: normalizeAllowedStorefronts(user.allowedStorefronts),
      portal: req.authPortal || undefined
    };
    req.userRole = req.user.role;

    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Token has expired',
        code: 'TOKEN_EXPIRED'
      });
    }

    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: 'Invalid token',
        code: 'INVALID_TOKEN'
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Error verifying token',
      error: error.message
    });
  }
};

module.exports = { verifyToken };