/**
 * Primary-instance scheduler: keep RTO providerStatus fresh (In Transit → Delivered)
 * without requiring an admin to open each order.
 *
 * Uses adminRtoAutoSync.service → reconcileOrderFromShiprocket only.
 * Does not change Orders-tab forward auto-sync behaviour.
 */
const logger = require('../utils/logger');
const { autoSyncStaleRtoOrdersInRange } = require('./adminRtoAutoSync.service');

function envFlagEnabled(name, defaultEnabled = true) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return defaultEnabled;
  const v = String(raw).trim().toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  return defaultEnabled;
}

function getIntervalMs() {
  const mins = Math.min(
    120,
    Math.max(5, Number(process.env.RTO_STATUS_SYNC_INTERVAL_MINUTES || 10))
  );
  return mins * 60 * 1000;
}

function getStaleMs() {
  const mins = Math.min(
    180,
    Math.max(5, Number(process.env.RTO_STATUS_SYNC_STALE_MINUTES || 15))
  );
  return mins * 60 * 1000;
}

function getLookbackDays() {
  return Math.min(730, Math.max(30, Number(process.env.RTO_STATUS_SYNC_LOOKBACK_DAYS || 365)));
}

function getConcurrency() {
  return Math.min(6, Math.max(1, Number(process.env.RTO_STATUS_SYNC_CONCURRENCY || 3)));
}

function getMaxRunMs() {
  return Math.min(
    180_000,
    Math.max(15_000, Number(process.env.RTO_STATUS_SYNC_MAX_RUN_MS || 90_000))
  );
}

class RtoStatusSyncScheduler {
  constructor() {
    this.interval = null;
    this.isRunning = false;
  }

  async runOnce() {
    if (!envFlagEnabled('RTO_STATUS_SYNC_ENABLED', true)) {
      return { skipped: true, reason: 'disabled' };
    }
    if (this.isRunning) {
      logger.debug('[rtoStatusSync] Previous run still in progress, skip');
      return { skipped: true, reason: 'in_progress' };
    }

    this.isRunning = true;
    try {
      const lookbackDays = getLookbackDays();
      const to = new Date();
      const from = new Date(to.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

      const result = await autoSyncStaleRtoOrdersInRange({
        from,
        to,
        staleMs: getStaleMs(),
        concurrency: getConcurrency(),
        maxRunMs: getMaxRunMs(),
        source: 'rto_cron_sync',
      });

      const s = result.summary || {};
      if (s.attempted > 0 || s.updated > 0 || s.failed > 0) {
        logger.info('[rtoStatusSync] Run complete', {
          attempted: s.attempted,
          synced: s.synced,
          updated: s.updated,
          failed: s.failed,
          skipped: s.skipped,
          remainingStale: s.remainingStale,
          complete: s.complete,
          timedOut: s.timedOut,
        });
      } else {
        logger.debug('[rtoStatusSync] No stale RTO candidates');
      }

      return result;
    } catch (err) {
      logger.error('[rtoStatusSync] Run failed', { message: err.message, stack: err.stack });
      return { success: false, message: err.message };
    } finally {
      this.isRunning = false;
    }
  }

  start() {
    if (this.interval) {
      logger.warn('[rtoStatusSync] Already started');
      return;
    }

    if (!envFlagEnabled('RTO_STATUS_SYNC_ENABLED', true)) {
      logger.info('[rtoStatusSync] Scheduler disabled via RTO_STATUS_SYNC_ENABLED');
      return;
    }

    // Delay first run slightly so startup / Mongo settle; then interval.
    setTimeout(() => {
      this.runOnce().catch((e) =>
        logger.error('[rtoStatusSync] Initial run error', { message: e.message })
      );
    }, 45_000);

    this.interval = setInterval(() => {
      this.runOnce().catch((e) =>
        logger.error('[rtoStatusSync] Interval run error', { message: e.message })
      );
    }, getIntervalMs());

    logger.info('[rtoStatusSync] Scheduler started', {
      intervalMinutes: getIntervalMs() / 60000,
      staleMinutes: getStaleMs() / 60000,
      lookbackDays: getLookbackDays(),
      concurrency: getConcurrency(),
    });
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      logger.info('[rtoStatusSync] Scheduler stopped');
    }
  }
}

const rtoStatusSyncScheduler = new RtoStatusSyncScheduler();
module.exports = rtoStatusSyncScheduler;
