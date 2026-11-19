'use strict';

/**
 * Dropshipper partner gate.
 * Accepts a dropshipper portal JWT only. Staff/admin tokens are not valid here.
 * DROPSHIPPER_AUTH_BYPASS=true is honored outside production only.
 */

const authService = require('../services/dropshipperAuth.service');

function isProduction() {
  const nodeEnv = String(process.env.NODE_ENV || '').toLowerCase();
  const appEnv = String(process.env.APP_ENV || '').toLowerCase();
  return nodeEnv === 'production' || appEnv === 'production';
}

function sendError(res, err) {
  const status = Number(err?.statusCode) || 401;
  return res.status(status).json({
    success: false,
    code: err?.code || 'UNAUTHORIZED',
    message: err?.message || 'Login required'
  });
}

async function requireDropshipperAccess(req, res, next) {
  const bypass = String(process.env.DROPSHIPPER_AUTH_BYPASS || '').toLowerCase() === 'true';
  if (bypass && !isProduction()) {
    req.dropshipperAccess = { mode: 'bypass' };
    return next();
  }

  try {
    const token = authService.readBearer(req.headers.authorization);
    const auth = await authService.authenticateAccessToken(token);
    req.dropshipperId = auth.id;
    req.userId = auth.id;
    req.dropshipper = auth.publicProfile;
    req.dropshipperAccess = { mode: 'dropshipper', dropshipperId: auth.id };
    return next();
  } catch (err) {
    return sendError(res, err);
  }
}

function requireActiveSubscription(req, res, next) {
  if (req.dropshipperAccess?.mode === 'bypass') return next();
  const gate = authService.subscriptionGate(req.dropshipper);
  if (!gate.ok) {
    return res.status(gate.status).json({
      success: false,
      code: gate.code,
      message: gate.message
    });
  }
  return next();
}

module.exports = {
  requireDropshipperAccess,
  requireActiveSubscription
};
