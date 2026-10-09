'use strict';

/**
 * Dropshipper module entry.
 * Phase 1: admin product visibility & pricing
 * Phase 2: serviceability check (warehouse → customer)
 * Phase 3: dropshipper catalog (list / detail / download-pack)
 * Phase 4: create order + Razorpay (online only) + admin dropship order list
 * Later: login / registration / subscription
 */

module.exports = {
  adminDropshipProductRoutes: require('./routes/adminDropshipProduct.route'),
  dropshipperRoutes: require('./routes/dropshipper.route')
};
