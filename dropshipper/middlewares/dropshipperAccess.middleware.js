'use strict';

/**
 * Temporary access gate for dropshipper APIs until dropshipper auth/subscription lands.
 * Production-safe: never open anonymously on live.
 *
 * Allowed today:
 * - JWT + admin | product_manager | inventory_manager
 * - OR env DROPSHIPPER_AUTH_BYPASS=true (non-production only)
 */

const { verifyToken } = require('../../middlewares/auth.middleware');
const { authorizeRoles } = require('../../middlewares/authorize-roles.middleware');

const staffGate = authorizeRoles('admin', 'product_manager', 'inventory_manager');

function requireDropshipperAccess(req, res, next) {
  const bypass = String(process.env.DROPSHIPPER_AUTH_BYPASS || '').toLowerCase() === 'true';
  const isProd =
    String(process.env.NODE_ENV || '').toLowerCase() === 'production' ||
    String(process.env.APP_ENV || '').toLowerCase() === 'production';

  if (bypass && !isProd) {
    req.dropshipperAccess = { mode: 'bypass' };
    return next();
  }

  // verifyToken sends 401 itself on failure (does not call next).
  return verifyToken(req, res, () => {
    return staffGate(req, res, () => {
      req.dropshipperAccess = { mode: 'staff', userId: req.userId };
      return next();
    });
  });
}

module.exports = {
  requireDropshipperAccess
};
