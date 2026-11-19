'use strict';

const authService = require('../services/dropshipperAuth.service');
const logger = require('../../utils/logger');

function handleError(res, err) {
  const known = Number(err?.statusCode) >= 400 && err?.code && err?.message;
  if (!known || err.statusCode >= 500) {
    logger.error('[dropshipperAdminAuth]', {
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

exports.getSettings = async (req, res) => {
  try {
    return res.json(await authService.getSubscriptionSettings());
  } catch (err) {
    return handleError(res, err);
  }
};

exports.updateSettings = async (req, res) => {
  try {
    return res.json(await authService.updateSettings(req.body || {}, req.userId));
  } catch (err) {
    return handleError(res, err);
  }
};

exports.listRequests = async (req, res) => {
  try {
    return res.json(await authService.listRequests(req.query || {}));
  } catch (err) {
    return handleError(res, err);
  }
};

exports.getRequest = async (req, res) => {
  try {
    return res.json(await authService.getRequest(req.params.id));
  } catch (err) {
    return handleError(res, err);
  }
};

exports.approveRequest = async (req, res) => {
  try {
    return res.json(
      await authService.approveRequest(req.params.id, {
        note: req.body?.note || req.body?.reason,
        reviewerId: req.userId
      })
    );
  } catch (err) {
    return handleError(res, err);
  }
};

exports.rejectRequest = async (req, res) => {
  try {
    return res.json(
      await authService.rejectRequest(req.params.id, {
        note: req.body?.note || req.body?.reason,
        reviewerId: req.userId
      })
    );
  } catch (err) {
    return handleError(res, err);
  }
};

exports.listAccounts = async (req, res) => {
  try {
    return res.json(await authService.listAccounts(req.query || {}));
  } catch (err) {
    return handleError(res, err);
  }
};

exports.getAccount = async (req, res) => {
  try {
    return res.json(await authService.getAccount(req.params.id));
  } catch (err) {
    return handleError(res, err);
  }
};
