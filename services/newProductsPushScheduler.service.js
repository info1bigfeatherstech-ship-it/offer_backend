const logger = require('../utils/logger');
const { isPushConfigured } = require('../utils/pushVapid');
const leadsPushSettingsService = require('./leadsPushSettings.service');
const { sendNewProductsDigest } = require('./newProductsPush.service');

function getIstParts(now = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const map = Object.fromEntries(
    parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value])
  );
  return {
    hour: Number(map.hour),
    dateKey: `${map.year}-${map.month}-${map.day}`,
  };
}

/** @returns {'morning'|'evening'|null} */
function resolveSlot(hour) {
  if (hour >= 11 && hour < 13) return 'morning';
  if (hour >= 18 && hour < 20) return 'evening';
  return null;
}

class NewProductsPushSchedulerService {
  constructor() {
    this.interval = null;
    this.isRunning = false;
  }

  async maybeRunDigest() {
    if (this.isRunning) {
      return { skipped: true, reason: 'IN_PROGRESS' };
    }
    if (!isPushConfigured()) {
      return { skipped: true, reason: 'PUSH_NOT_CONFIGURED' };
    }

    const { hour, dateKey } = getIstParts();
    const slot = resolveSlot(hour);
    if (!slot) {
      return { skipped: true, reason: 'OUTSIDE_WINDOW', hour };
    }

    const ecommEnabled = await leadsPushSettingsService.isNewProductsAutoPushEnabled('ecomm');
    const wholesaleEnabled = await leadsPushSettingsService.isNewProductsAutoPushEnabled('wholesale');
    if (!ecommEnabled && !wholesaleEnabled) {
      return { skipped: true, reason: 'AUTO_DISABLED' };
    }

    this.isRunning = true;
    try {
      const results = { slot, dateKey, ecomm: null, wholesale: null };

      if (ecommEnabled) {
        results.ecomm = await this.runForStorefront({
          storefront: 'ecomm',
          scopeQuery: { userType: 'user' },
          slot,
          dateKey,
        });
      }

      if (wholesaleEnabled) {
        results.wholesale = await this.runForStorefront({
          storefront: 'wholesale',
          scopeQuery: { userType: 'wholesaler' },
          slot,
          dateKey,
        });
      }

      return results;
    } catch (err) {
      logger.error('[newProductsPushScheduler] run failed', {
        message: err?.message || String(err),
      });
      return { failed: true, message: err?.message || String(err) };
    } finally {
      this.isRunning = false;
    }
  }

  async runForStorefront({ storefront, scopeQuery, slot, dateKey }) {
    const settings = await leadsPushSettingsService.getSettingsDoc(storefront);
    const already =
      slot === 'morning'
        ? settings.lastNewProductsMorningDateKey === dateKey
        : settings.lastNewProductsEveningDateKey === dateKey;

    if (already) {
      return { skipped: true, reason: 'SLOT_ALREADY_RAN', storefront, slot, dateKey };
    }

    // First enable / fresh settings: seed watermark to now so we never blast the entire catalog.
    if (!settings.lastNewProductsDigestAt) {
      await leadsPushSettingsService.markNewProductsDigestSent(storefront, {
        slot,
        dateKey,
        digestAt: new Date(),
        updateWatermark: true,
      });
      return {
        skipped: true,
        reason: 'WATERMARK_BOOTSTRAP',
        storefront,
        slot,
        dateKey,
      };
    }

    const outcome = await sendNewProductsDigest({
      storefront,
      scopeQuery,
      sinceDate: new Date(settings.lastNewProductsDigestAt),
    });

    if (outcome?.skipped && outcome.reason === 'NO_NEW_PRODUCTS') {
      // Mark slot only — keep watermark so later listings still qualify in the other window.
      await leadsPushSettingsService.markNewProductsDigestSent(storefront, {
        slot,
        dateKey,
        updateWatermark: false,
      });
      return outcome;
    }

    if (outcome?.skipped) {
      return outcome;
    }

    // Advance watermark after a real digest attempt for this batch of products.
    await leadsPushSettingsService.markNewProductsDigestSent(storefront, {
      slot,
      dateKey,
      digestAt: new Date(),
      updateWatermark: true,
    });

    return outcome;
  }

  start() {
    if (this.interval) {
      logger.info('[newProductsPushScheduler] already running');
      return;
    }

    const scanMinutes = Math.min(
      30,
      Math.max(5, Number(process.env.NEW_PRODUCTS_PUSH_SCAN_MINUTES || 10))
    );
    const scanMs = scanMinutes * 60 * 1000;

    this.maybeRunDigest().catch((err) => {
      logger.error('[newProductsPushScheduler] initial run error', {
        message: err?.message || String(err),
      });
    });

    this.interval = setInterval(() => {
      this.maybeRunDigest().catch((err) => {
        logger.error('[newProductsPushScheduler] interval error', {
          message: err?.message || String(err),
        });
      });
    }, scanMs);

    logger.info('[newProductsPushScheduler] started', {
      scanMinutes,
      windowsIst: ['11:00–13:00', '18:00–20:00'],
    });
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      logger.info('[newProductsPushScheduler] stopped');
    }
  }
}

module.exports = new NewProductsPushSchedulerService();
