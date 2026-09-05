const logger = require('../utils/logger');
const { isPushConfigured } = require('../utils/pushVapid');
const { sendAutoWishlistReminderPushes } = require('./wishlistReminderPush.service');
const leadsPushSettingsService = require('./leadsPushSettings.service');

function getIstHourAndDateKey(now = new Date()) {
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

class WishlistReminderPushSchedulerService {
  constructor() {
    this.interval = null;
    this.isRunning = false;
    this.lastAutoRunDateKey = null;
  }

  async maybeRunAutoPush() {
    if (this.isRunning) {
      return { skipped: true, reason: 'IN_PROGRESS' };
    }
    if (!isPushConfigured()) {
      return { skipped: true, reason: 'PUSH_NOT_CONFIGURED' };
    }

    const ecommEnabled = await leadsPushSettingsService.isWishlistAutoPushEnabled('ecomm');
    const wholesaleEnabled = await leadsPushSettingsService.isWishlistAutoPushEnabled('wholesale');
    if (!ecommEnabled && !wholesaleEnabled) {
      return { skipped: true, reason: 'AUTO_DISABLED' };
    }

    const { hour, dateKey } = getIstHourAndDateKey();
    const targetHour = leadsPushSettingsService.getAutoPushHourIst();

    if (hour !== targetHour) {
      return { skipped: true, reason: 'NOT_SCHEDULED_HOUR', hour, targetHour };
    }
    if (this.lastAutoRunDateKey === dateKey) {
      return { skipped: true, reason: 'ALREADY_RAN_TODAY' };
    }

    this.isRunning = true;
    try {
      const results = { ecomm: null, wholesale: null };

      if (ecommEnabled) {
        results.ecomm = await sendAutoWishlistReminderPushes({
          scopeQuery: { userType: 'user' },
          storefront: 'ecomm',
        });
      }
      if (wholesaleEnabled) {
        results.wholesale = await sendAutoWishlistReminderPushes({
          scopeQuery: { userType: 'wholesaler' },
          storefront: 'wholesale',
        });
      }

      this.lastAutoRunDateKey = dateKey;
      return results;
    } catch (err) {
      logger.error('[wishlistReminderPushScheduler] auto run failed', {
        message: err?.message || String(err),
      });
      return { failed: true, message: err?.message || String(err) };
    } finally {
      this.isRunning = false;
    }
  }

  start() {
    if (this.interval) {
      logger.info('[wishlistReminderPushScheduler] already running');
      return;
    }

    const scanMinutes = Math.min(
      60,
      Math.max(5, Number(process.env.WISHLIST_REMINDER_PUSH_AUTO_SCAN_MINUTES || 15))
    );
    const scanMs = scanMinutes * 60 * 1000;

    this.maybeRunAutoPush().catch((err) => {
      logger.error('[wishlistReminderPushScheduler] initial run error', {
        message: err?.message || String(err),
      });
    });

    this.interval = setInterval(() => {
      this.maybeRunAutoPush().catch((err) => {
        logger.error('[wishlistReminderPushScheduler] interval error', {
          message: err?.message || String(err),
        });
      });
    }, scanMs);

    logger.info('[wishlistReminderPushScheduler] started', {
      scanMinutes,
      autoHourIst: leadsPushSettingsService.getAutoPushHourIst(),
    });
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      logger.info('[wishlistReminderPushScheduler] stopped');
    }
  }
}

module.exports = new WishlistReminderPushSchedulerService();
