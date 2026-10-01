'use strict';

/**
 * Dropshipper-facing serviceability routes.
 * Mount: /api/dropshipper
 */

const express = require('express');
const router = express.Router();
const { requireDropshipperAccess } = require('../middlewares/dropshipperAccess.middleware');
const controller = require('../controllers/serviceability.controller');

router.post('/serviceability/check', requireDropshipperAccess, controller.checkServiceability);

module.exports = router;
