'use strict';

const authService = require('../services/dropshipperAuth.service');
const logger = require('../../utils/logger');

function handleError(res, err) {
  const known = Number(err?.statusCode) >= 400 && err?.code && err?.message;
  if (!known || err.statusCode >= 500) {
    logger.error('[dropshipperAuth]', {
      message: err?.message,
      code: err?.code,
      statusCode: err?.statusCode
    });
  }
  if (!known) {
    return res.status(500).json({
      success: false,
      code: 'INTERNAL_ERROR',
      message: authService.isProduction()
        ? 'Something went wrong. Please try again.'
        : err?.message || 'Request failed'
    });
  }
  return res.status(err.statusCode).json({
    success: false,
    code: err.code,
    message: err.message
  });
}

exports.getSubscriptionSettings = async (req, res) => {
  try {
    return res.json(await authService.getSubscriptionSettings());
  } catch (err) {
    return handleError(res, err);
  }
};

exports.startRegistration = async (req, res) => {
  try {
    return res.json(await authService.startRegistration(req.body || {}));
  } catch (err) {
    return handleError(res, err);
  }
};

exports.createRegistrationPayment = async (req, res) => {
  try {
    const result = await authService.createRegistrationPayment({
      body: req.body || {},
      files: req.files
    });
    return res.status(201).json(result);
  } catch (err) {
    return handleError(res, err);
  }
};

exports.verifyRegistrationPayment = async (req, res) => {
  try {
    return res.json(await authService.verifyRegistrationPayment(req.body || {}));
  } catch (err) {
    return handleError(res, err);
  }
};

exports.getRegistrationStatus = async (req, res) => {
  try {
    return res.json(await authService.getRegistrationStatus(req.params.requestId, req.query || {}));
  } catch (err) {
    return handleError(res, err);
  }
};

exports.sendActivationOtp = async (req, res) => {
  try {
    return res.json(await authService.sendActivationOtp(req.body || {}));
  } catch (err) {
    return handleError(res, err);
  }
};

exports.completeActivation = async (req, res) => {
  try {
    return res.json(await authService.completeActivation(req.body || {}));
  } catch (err) {
    return handleError(res, err);
  }
};

exports.login = async (req, res) => {
  try {
    return res.json(await authService.login(req.body || {}));
  } catch (err) {
    return handleError(res, err);
  }
};

exports.refresh = async (req, res) => {
  try {
    return res.json(await authService.refreshSession(req.body || {}));
  } catch (err) {
    return handleError(res, err);
  }
};

exports.me = async (req, res) => {
  try {
    return res.json(await authService.getMe(req.dropshipperId));
  } catch (err) {
    return handleError(res, err);
  }
};

exports.logout = async (req, res) => {
  try {
    const accessToken = authService.readBearer(req.headers.authorization);
    return res.json(
      await authService.logout({
        accessToken,
        refreshToken: req.body?.refreshToken,
        dropshipperId: req.dropshipperId
      })
    );
  } catch (err) {
    return handleError(res, err);
  }
};

exports.renewQuote = async (req, res) => {
  try {
    return res.json(await authService.renewQuote(req.dropshipperId));
  } catch (err) {
    return handleError(res, err);
  }
};

exports.renewCreatePayment = async (req, res) => {
  try {
    return res.json(await authService.renewCreatePayment(req.dropshipperId));
  } catch (err) {
    return handleError(res, err);
  }
};

exports.renewVerifyPayment = async (req, res) => {
  try {
    return res.json(await authService.renewVerifyPayment(req.dropshipperId, req.body || {}));
  } catch (err) {
    return handleError(res, err);
  }
};
