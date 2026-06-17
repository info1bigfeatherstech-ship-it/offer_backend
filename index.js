/**
 * index.js - Application entry point.
 *
 * Responsibilities:
 *   1. Load environment variables from .env BEFORE any other module reads them.
 *   2. Install temporary last-resort handlers for uncaught errors during the
 *      boot window. These are removed once gracefulShutdown takes over so its
 *      coordinated shutdown logic is not pre-empted.
 *   3. Delegate every actual behaviour to ./server.js.
 *
 * Keep this file thin -- all middleware/routes/startup logic lives in
 * `server.js`. Entry script in package.json must remain `index.js`.
 */

const path = require('path');
// Load `.env` beside this file (not `process.cwd()`), so variables like
// SHIPROCKET_PICKUP_LOCATION are present when the app is started from another directory.
require('dotenv').config({ path: path.join(__dirname, '.env') });
try {
  const fs = require('fs');
  const envLocal = path.join(__dirname, '.env.local');
  if (fs.existsSync(envLocal)) {
    require('dotenv').config({ path: envLocal, override: true });
  }
} catch (_) {
  
  /* ignore optional .env.local */
}

// Sentry MUST be initialised right after env loading and before any other
// module (express, mongoose, redis, http) is required, so OpenTelemetry can
// patch them for automatic error/transaction capture. No-op when SENTRY_DSN
// is not configured.
require('./instrument');

const bootUncaughtHandler = (error) => {
  // eslint-disable-next-line no-console
  console.error('[Boot] Uncaught exception before server bootstrap:', error);
  process.exit(1);
};

const bootRejectionHandler = (reason) => {
  // eslint-disable-next-line no-console
  console.error('[Boot] Unhandled rejection before server bootstrap:', reason);
  process.exit(1);
};

process.on('uncaughtException', bootUncaughtHandler);
process.on('unhandledRejection', bootRejectionHandler);

const { app, startApplication, gracefulShutdown } = require('./server');

// Hand off to the server's graceful shutdown service once boot is in flight.
// gracefulShutdown.setupProcessHandlers() will install its own coordinated
// handlers from inside startApplication().
process.off('uncaughtException', bootUncaughtHandler);
process.off('unhandledRejection', bootRejectionHandler);

startApplication();

module.exports = { app, gracefulShutdown };
