const mongoose = require('mongoose');
const redisManager = require('../config/redis.config');
const logger = require('../utils/logger');

class GracefulShutdownService {
  constructor() {
    this.server = null;
    this.shutdownTimeout = parseInt(process.env.SHUTDOWN_TIMEOUT) || 30000;
    this.isShuttingDown = false;
    this.connections = new Set();
  }

  registerServer(server) {
    this.server = server;
  }

  registerConnection(name, closeFn) {
    this.connections.add({ name, closeFn });
  }

  async shutdown(signal) {
    if (this.isShuttingDown) {
      logger.warn('[Shutdown] Already shutting down, ignoring duplicate signal');
      return;
    }

    this.isShuttingDown = true;
    logger.info(`[Shutdown] ${signal} received - initiating graceful shutdown`);

    // Force exit after timeout
    const forceExitTimeout = setTimeout(() => {
      logger.error('[Shutdown] Timeout exceeded - forcing exit');
      process.exit(1);
    }, this.shutdownTimeout);

    try {
      // Stop accepting new requests
      if (this.server) {
        await this.stopAcceptingRequests();
      }

      // Close all registered connections in parallel with timeout
      await this.closeAllConnections();

      // Final cleanup
      await this.finalCleanup();

      clearTimeout(forceExitTimeout);
      logger.info('[Shutdown] Graceful shutdown completed successfully');
      process.exit(0);
    } catch (error) {
      logger.error(`[Shutdown] Error during shutdown: ${error.message}`);
      clearTimeout(forceExitTimeout);
      process.exit(1);
    }
  }

  async stopAcceptingRequests() {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('Server close timeout'));
      }, 5000);

      this.server.close((err) => {
        clearTimeout(timeout);
        if (err) {
          logger.error(`[Shutdown] Error closing server: ${err.message}`);
          reject(err);
        } else {
          logger.info('[Shutdown] HTTP server closed');
          resolve();
        }
      });

      // Force close existing connections after delay
      setTimeout(() => {
        if (this.server.listening) {
          logger.warn('[Shutdown] Force closing active connections');
          this.server.closeAllConnections?.();
        }
      }, 3000);
    });
  }

  async closeAllConnections() {
    const closePromises = Array.from(this.connections).map(async ({ name, closeFn }) => {
      try {
        logger.info(`[Shutdown] Closing ${name} connection...`);
        await this.withTimeout(closeFn(), 5000, `${name} timeout`);
        logger.info(`[Shutdown] ${name} connection closed`);
      } catch (error) {
        logger.error(`[Shutdown] Failed to close ${name}: ${error.message}`);
      }
    });

    await Promise.allSettled(closePromises);
  }

  async withTimeout(promise, timeoutMs, errorMessage) {
    let timeoutHandle;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(errorMessage));
      }, timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  async finalCleanup() {
    // Close MongoDB connection
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.close(false);
      logger.info('[Shutdown] MongoDB connection closed');
    }

    // Close Redis connection
    await redisManager.disconnect();

    // Additional cleanup tasks
    await this.cleanupTempFiles();
    await this.flushLogs();
  }

  async cleanupTempFiles() {
    // Clean up temporary files if any
    const fs = require('fs').promises;
    const path = require('path');
    const tempDir = path.join(__dirname, '../temp');
    
    try {
      const files = await fs.readdir(tempDir);
      await Promise.all(files.map(file => fs.unlink(path.join(tempDir, file))));
      logger.info(`[Shutdown] Cleaned up ${files.length} temp files`);
    } catch (error) {
      // Directory might not exist, ignore
    }
  }

  async flushLogs() {
    // Ensure all logs are written
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  setupProcessHandlers() {
    // Handle various shutdown signals
    const signals = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT'];

    signals.forEach(signal => {
      process.on(signal, () => {
        this.shutdown(signal);
      });
    });

    // uncaughtException -> shutdown is justified: synchronous throw means
    // application state may be corrupted, safer to restart via PM2.
    process.on('uncaughtException', (error) => {
      logger.error(`[Fatal] Uncaught Exception: ${error.message}`, {
        stack: error.stack
      });
      this.shutdown('UNCAUGHT_EXCEPTION');
    });

    // unhandledRejection -> log only. Crashing the whole process for a single
    // stray rejection (third-party SDK glitch, transient network blip, etc.)
    // creates PM2 restart loops and customer-facing 502s. Node.js 20+ default
    // is also "warn only"; we keep that behaviour and surface the reason for
    // post-mortem.
    process.on('unhandledRejection', (reason, promise) => {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      logger.error(`[Fatal] Unhandled Rejection: ${error.message}`, {
        stack: error.stack,
        reason: typeof reason === 'object' ? undefined : String(reason)
      });
    });

    process.on('warning', (warning) => {
      logger.warn(`[Process Warning] ${warning.name}: ${warning.message}`);
    });
  }
}

module.exports = new GracefulShutdownService();