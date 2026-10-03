'use strict';

/**
 * Dropshipper module entry.
 * Phase 1: admin product visibility & pricing
 * Phase 2: serviceability check (warehouse → customer)
 * Login / registration / subscription / orders — later phases.
 */

module.exports = {
  adminDropshipProductRoutes: require('./routes/adminDropshipProduct.route'),
  dropshipperRoutes: require('./routes/dropshipper.route')
};
