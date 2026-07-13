/**
 * Production back-in-stock notifier for OutOfStockInquiry waitlist.
 *
 * Trigger: variant inventory transitions from <=0 → >0.
 * Safety: atomic claim pending → notifying, then notified / reclaim on failure.
 * Channels: email (marketing) + in-app website notifications (UserNotification).
 * Never blocks the inventory write path — callers should fire-and-forget.
 */
const nodemailer = require('nodemailer');
const OutOfStockInquiry = require('../models/OutOfStockInquiry');
const Product = require('../models/Product');
const logger = require('../utils/logger');
const template = require('../templates/oosRestockEmail.template');

const SEND_DELAY_MS = Math.min(
  2000,
  Math.max(150, Number(process.env.OOS_RESTOCK_NOTIFY_DELAY_MS || 350))
);
const MAX_PER_VARIANT = Math.min(
  500,
  Math.max(1, Number(process.env.OOS_RESTOCK_NOTIFY_MAX_PER_VARIANT || 200))
);
const CLAIM_STALE_MS = 15 * 60 * 1000;

let cachedTransporter = null;

function envFlagEnabled(name, defaultEnabled = true) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return defaultEnabled;
  const v = String(raw).trim().toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  return defaultEnabled;
}

function getMarketingEmailUser() {
  return String(process.env.MARKETING_EMAIL_USER || '').trim();
}

function getMarketingEmailPassword() {
  return String(process.env.MARKETING_EMAIL_PASSWORD || '').trim();
}

function getMarketingFromAddress() {
  const fromName = String(process.env.MARKETING_EMAIL_FROM_NAME || 'OfferWaaleBaba').trim();
  const fromEmail = getMarketingEmailUser();
  return `"${fromName}" <${fromEmail}>`;
}

function getTransporter() {
  if (cachedTransporter) return cachedTransporter;
  const user = getMarketingEmailUser();
  const pass = getMarketingEmailPassword();
  if (!user || !pass) {
    const err = new Error(
      'Marketing email is not configured. Set MARKETING_EMAIL_USER and MARKETING_EMAIL_PASSWORD.'
    );
    err.code = 'EMAIL_NOT_CONFIGURED';
    throw err;
  }
  cachedTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });
  return cachedTransporter;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function storefrontBaseUrl(storefront) {
  if (storefront === 'wholesale') {
    return String(
      process.env.WHOLESALE_FRONTEND_URL ||
        process.env.FRONTEND_URL ||
        process.env.STORE_URL ||
        'https://offerwalebaba.com'
    ).replace(/\/$/, '');
  }
  return String(process.env.FRONTEND_URL || process.env.STORE_URL || 'https://offerwalebaba.com').replace(
    /\/$/,
    ''
  );
}

function buildProductUrl(inquiry) {
  const base = storefrontBaseUrl(inquiry.storefront);
  const slug = String(inquiry.productSlug || '').trim();
  if (!slug) return base;
  return `${base}/products/${encodeURIComponent(slug)}`;
}

function fillTemplate(str, map) {
  return String(str || '').replace(/\{\{(\w+)\}\}/g, (_, key) =>
    map[key] != null ? String(map[key]) : ''
  );
}

function isRestockTransition(prevQty, nextQty, trackInventory) {
  if (trackInventory === false) return false;
  const prev = Number(prevQty);
  const next = Number(nextQty);
  if (!Number.isFinite(next) || next <= 0) return false;
  const wasOut = !Number.isFinite(prev) || prev <= 0;
  return wasOut;
}

/**
 * @param {{ productId: unknown, variantId: unknown, productSlug?: string, productName?: string, variantSku?: string, productImage?: string }} event
 */
async function enrichRestockEvent(event) {
  const productId = event.productId;
  const variantId = event.variantId;
  if (!productId || !variantId) return null;

  let productSlug = event.productSlug || null;
  let productName = event.productName || null;
  let variantSku = event.variantSku || null;
  let productImage = event.productImage || null;

  if (!productSlug || !productName) {
    const product = await Product.findById(productId)
      .select('name slug variants')
      .lean();
    if (!product) return null;
    productSlug = product.slug || productSlug;
    productName = product.name || productName;
    const variant = (product.variants || []).find((v) => String(v._id) === String(variantId));
    if (variant) {
      variantSku = variant.sku || variantSku;
      const img = Array.isArray(variant.images) && variant.images[0];
      productImage =
        (typeof img === 'string' ? img : img?.url) || productImage || null;
    }
  }

  return {
    productId,
    variantId,
    productSlug,
    productName: productName || 'Product',
    variantSku,
    productImage,
  };
}

async function claimInquiry(inquiryId) {
  const staleBefore = new Date(Date.now() - CLAIM_STALE_MS);
  return OutOfStockInquiry.findOneAndUpdate(
    {
      _id: inquiryId,
      $or: [
        { status: 'pending' },
        { status: 'notifying', lastNotifyAttemptAt: { $lt: staleBefore } },
      ],
    },
    {
      $set: {
        status: 'notifying',
        lastNotifyAttemptAt: new Date(),
        lastNotifyError: null,
      },
      $inc: { notifyAttempts: 1 },
    },
    { new: true }
  );
}

async function markNotified(inquiryId, channels) {
  await OutOfStockInquiry.updateOne(
    { _id: inquiryId, status: 'notifying' },
    {
      $set: {
        status: 'notified',
        notifiedAt: new Date(),
        lastNotifyError: null,
        notifyChannelsSent: channels,
      },
    }
  );
}

async function releaseClaim(inquiryId, errorMessage) {
  await OutOfStockInquiry.updateOne(
    { _id: inquiryId, status: 'notifying' },
    {
      $set: {
        status: 'pending',
        lastNotifyError: String(errorMessage || 'notify_failed').slice(0, 500),
      },
    }
  );
}

async function sendRestockEmail(inquiry, ctx) {
  if (!inquiry.email) {
    const err = new Error('No email on inquiry');
    err.code = 'EMAIL_MISSING';
    throw err;
  }
  const transporter = getTransporter();
  const productName = ctx.productName || inquiry.productName || 'your item';
  const productUrl = buildProductUrl({
    ...(inquiry.toObject?.() || inquiry),
    productSlug: ctx.productSlug || inquiry.productSlug,
  });
  const map = {
    productName: escapeHtml(productName),
    productUrl,
    greeting: template.greeting,
    intro: template.intro,
    ctaLabel: template.ctaLabel,
    footer: template.footer,
  };
  const subject = fillTemplate(template.subject, { productName });
  const html = fillTemplate(template.htmlLayout, map);
  const text = `${template.greeting}\n\n${productName} is back in stock.\n${template.intro}\n\n${productUrl}\n`;

  await transporter.sendMail({
    from: getMarketingFromAddress(),
    to: inquiry.email,
    subject,
    html,
    text,
  });
}

/**
 * Resolve account for in-app bell notifications.
 * Prefers inquiry.userId, else match User by email/phone.
 */
async function resolveUserIdForInquiry(inquiry) {
  if (inquiry.userId) return inquiry.userId;
  const User = require('../models/User');
  if (inquiry.email) {
    const byEmail = await User.findOne({ email: String(inquiry.email).toLowerCase() })
      .select('_id')
      .lean();
    if (byEmail?._id) return byEmail._id;
  }
  if (inquiry.phone) {
    const byPhone = await User.findOne({ phone: String(inquiry.phone).trim() })
      .select('_id')
      .lean();
    if (byPhone?._id) return byPhone._id;
  }
  return null;
}

/**
 * In-app notification in the website Notifications centre.
 * Uses synthetic orderId `oos:{inquiryId}` for idempotency with existing unique index.
 */
async function sendInAppRestockNotification(inquiry, ctx) {
  const userId = await resolveUserIdForInquiry(inquiry);
  if (!userId) {
    const err = new Error('No logged-in user account to attach in-app notification');
    err.code = 'IN_APP_USER_MISSING';
    throw err;
  }

  const UserNotification = require('../models/UserNotification');
  const productName = ctx.productName || inquiry.productName || 'Your item';
  const productSlug = ctx.productSlug || inquiry.productSlug || null;
  const inquiryId = String(inquiry._id);
  const syntheticOrderId = `oos:${inquiryId}`;
  const title = 'Back in stock';
  const body = `${productName} is available again. Tap to view the product and order before it sells out.`;

  try {
    await UserNotification.findOneAndUpdate(
      { userId, orderId: syntheticOrderId, type: 'back_in_stock' },
      {
        $set: {
          userId,
          orderId: syntheticOrderId,
          type: 'back_in_stock',
          title,
          body,
          read: false,
          sentAt: new Date(),
          metadata: {
            reason: 'back_in_stock',
            refundAmount: null,
            orderTotal: null,
            policyUrl: null,
            productSlug: productSlug || null,
            productId: inquiry.productId ? String(inquiry.productId) : null,
            inquiryId,
          },
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (err) {
    if (err && err.code === 11000) {
      return { created: false };
    }
    throw err;
  }
  return { created: true };
}

/**
 * Deliver via email and/or in-app. At least one channel must succeed.
 */
async function deliverInquiry(inquiry, ctx) {
  const channels = [];
  const errors = [];

  if (inquiry.email) {
    try {
      await sendRestockEmail(inquiry, ctx);
      channels.push('email');
    } catch (err) {
      errors.push(`email:${err.code || err.message}`);
      logger.warn('[oosRestockNotify] email failed', {
        inquiryId: String(inquiry._id),
        message: err.message,
        code: err.code,
      });
    }
  }

  try {
    await sendInAppRestockNotification(inquiry, ctx);
    channels.push('in_app');
  } catch (err) {
    errors.push(`in_app:${err.code || err.message}`);
    logger.warn('[oosRestockNotify] in-app failed', {
      inquiryId: String(inquiry._id),
      message: err.message,
      code: err.code,
    });
  }

  if (!channels.length) {
    const err = new Error(errors.join('; ') || 'No channel succeeded');
    err.code = 'ALL_CHANNELS_FAILED';
    throw err;
  }

  return channels;
}

/**
 * Process pending waitlist for a restocked variant.
 * @param {{ productId: unknown, variantId: unknown, productSlug?: string, productName?: string }} event
 */
async function notifyPendingInquiriesForRestock(event) {
  if (!envFlagEnabled('OOS_RESTOCK_NOTIFY_ENABLED', true)) {
    return { skipped: true, reason: 'disabled' };
  }

  const enriched = await enrichRestockEvent(event);
  if (!enriched) {
    return { skipped: true, reason: 'invalid_event' };
  }

  const productId = enriched.productId;
  const variantId = enriched.variantId;

  const pending = await OutOfStockInquiry.find({
    productId,
    variantId,
    $or: [
      { status: 'pending' },
      {
        status: 'notifying',
        lastNotifyAttemptAt: { $lt: new Date(Date.now() - CLAIM_STALE_MS) },
      },
    ],
  })
    .sort({ createdAt: 1 })
    .limit(MAX_PER_VARIANT)
    .select('_id')
    .lean();

  if (!pending.length) {
    return { attempted: 0, notified: 0, failed: 0 };
  }

  let notified = 0;
  let failed = 0;

  for (const row of pending) {
    const claimed = await claimInquiry(row._id);
    if (!claimed) continue;

    try {
      const channels = await deliverInquiry(claimed, enriched);
      await markNotified(claimed._id, channels);
      notified += 1;
    } catch (err) {
      failed += 1;
      await releaseClaim(claimed._id, err.message);
    }

    if (SEND_DELAY_MS > 0) await sleep(SEND_DELAY_MS);
  }

  logger.info('[oosRestockNotify] variant batch complete', {
    productId: String(productId),
    variantId: String(variantId),
    attempted: pending.length,
    notified,
    failed,
  });

  return { attempted: pending.length, notified, failed };
}

/**
 * @param {Array<{ productId: unknown, variantId: unknown, productSlug?: string, productName?: string }>} events
 */
async function notifyPendingInquiriesForRestocks(events) {
  if (!Array.isArray(events) || !events.length) return [];
  const results = [];
  const seen = new Set();
  for (const event of events) {
    const key = `${String(event.productId)}:${String(event.variantId)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      results.push(await notifyPendingInquiriesForRestock(event));
    } catch (err) {
      logger.error('[oosRestockNotify] batch item failed', {
        key,
        message: err.message,
      });
      results.push({ success: false, message: err.message });
    }
  }
  return results;
}

/**
 * Non-blocking schedule from inventory write paths.
 * @param {Array|{ productId: unknown, variantId: unknown }} eventsOrOne
 */
function scheduleRestockNotifications(eventsOrOne) {
  const events = Array.isArray(eventsOrOne) ? eventsOrOne : [eventsOrOne];
  const filtered = events.filter((e) => e && e.productId && e.variantId);
  if (!filtered.length) return;

  setImmediate(() => {
    notifyPendingInquiriesForRestocks(filtered).catch((err) => {
      logger.error('[oosRestockNotify] schedule failed', { message: err.message });
    });
  });
}

module.exports = {
  isRestockTransition,
  notifyPendingInquiriesForRestock,
  notifyPendingInquiriesForRestocks,
  scheduleRestockNotifications,
  CLAIM_STALE_MS,
  MAX_PER_VARIANT,
};
