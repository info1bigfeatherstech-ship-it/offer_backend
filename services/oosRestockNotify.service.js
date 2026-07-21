/**
 * Production back-in-stock notifier for OutOfStockInquiry waitlist.
 *
 * Trigger:
 * - Classic: qty <=0 → >0 (ecomm + wholesale true OOS)
 * - Wholesale MOQ: was below MOQ with stock >0 → next >= MOQ
 *
 * Delivery filter (per inquiry):
 * - ecomm / out_of_stock: notify when qty > 0
 * - wholesale moq_unmet: notify when qty >= MOQ
 *
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

function toSafeQty(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function resolveMinimumOrderQuantity(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.max(1, Math.floor(n)) : 1;
}

/**
 * Inventory transition that may unblock waitlist notifications.
 * 3-arg call sites stay ecomm-safe (classic <=0 → >0 only when MOQ omitted / 1).
 *
 * @param {unknown} prevQty
 * @param {unknown} nextQty
 * @param {boolean} trackInventory
 * @param {{ minimumOrderQuantity?: unknown }} [options]
 */
function isRestockTransition(prevQty, nextQty, trackInventory, options = {}) {
  if (trackInventory === false) return false;
  const prev = toSafeQty(prevQty);
  const next = toSafeQty(nextQty);
  if (!Number.isFinite(next) || next <= 0) return false;

  // Classic true OOS → any positive stock (ecomm + wholesale OOS waitlist)
  const wasOut = !Number.isFinite(prev) || prev <= 0;
  if (wasOut) return true;

  // Wholesale MOQ path: stock was positive but below MOQ, now meets MOQ
  const moq = resolveMinimumOrderQuantity(options?.minimumOrderQuantity);
  if (moq <= 1) return false;
  return Number.isFinite(prev) && prev > 0 && prev < moq && next >= moq;
}

/**
 * Whether this pending inquiry should be notified for the current stock level.
 * Legacy rows without reason are treated as out_of_stock.
 *
 * @param {{ storefront?: string, reason?: string }} inquiry
 * @param {{ quantity: number, minimumOrderQuantity: number, trackInventory: boolean }} stock
 */
function shouldNotifyInquiryForStock(inquiry, stock) {
  if (!stock || stock.trackInventory === false) return false;
  const qty = toSafeQty(stock.quantity);
  if (!Number.isFinite(qty) || qty <= 0) return false;

  const reason = inquiry?.reason === 'moq_unmet' ? 'moq_unmet' : 'out_of_stock';
  const storefront = inquiry?.storefront === 'wholesale' ? 'wholesale' : 'ecomm';

  if (storefront === 'wholesale' && reason === 'moq_unmet') {
    return qty >= resolveMinimumOrderQuantity(stock.minimumOrderQuantity);
  }

  // ecomm + wholesale true OOS waitlist
  return qty > 0;
}

/**
 * @param {{ productId: unknown, variantId: unknown, productSlug?: string, productName?: string, variantSku?: string, productImage?: string }} event
 */
async function enrichRestockEvent(event) {
  const productId = event.productId;
  const variantId = event.variantId;
  if (!productId || !variantId) return null;

  const product = await Product.findById(productId)
    .select('name slug variants')
    .lean();
  if (!product) return null;

  const variant = (product.variants || []).find((v) => String(v._id) === String(variantId));
  if (!variant) return null;

  const img = Array.isArray(variant.images) && variant.images[0];
  const productImage =
    (typeof img === 'string' ? img : img?.url) || event.productImage || null;

  return {
    productId,
    variantId,
    productSlug: event.productSlug || product.slug || null,
    productName: event.productName || product.name || 'Product',
    variantSku: event.variantSku || variant.sku || null,
    productImage,
    quantity: Number(variant.inventory?.quantity || 0),
    minimumOrderQuantity: resolveMinimumOrderQuantity(variant.minimumOrderQuantity),
    trackInventory: variant.inventory?.trackInventory !== false,
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

function isMoqUnmetInquiry(inquiry) {
  return inquiry?.reason === 'moq_unmet' && inquiry?.storefront === 'wholesale';
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
  const moqCopy = isMoqUnmetInquiry(inquiry);
  const copy = moqCopy
    ? {
        subject: template.moqSubject || template.subject,
        greeting: template.moqGreeting || template.greeting,
        intro: template.moqIntro || template.intro,
        stockLine: template.moqStockLine || '<strong>{{productName}}</strong> is now available for wholesale order.',
        ctaLabel: template.moqCtaLabel || template.ctaLabel,
        footer: template.moqFooter || template.footer,
        textBody:
          template.moqTextBody ||
          `${productName} is now available for wholesale order.\n${template.moqIntro || template.intro}`,
      }
    : {
        subject: template.subject,
        greeting: template.greeting,
        intro: template.intro,
        stockLine: '<strong>{{productName}}</strong> is back in stock.',
        ctaLabel: template.ctaLabel,
        footer: template.footer,
        textBody: `${productName} is back in stock.\n${template.intro}`,
      };

  const map = {
    productName: escapeHtml(productName),
    productUrl,
    greeting: copy.greeting,
    intro: copy.intro,
    stockLine: fillTemplate(copy.stockLine, { productName: escapeHtml(productName) }),
    ctaLabel: copy.ctaLabel,
    footer: copy.footer,
  };
  const subject = fillTemplate(copy.subject, { productName });
  const html = fillTemplate(template.htmlLayout, map);
  const text = `${copy.greeting}\n\n${fillTemplate(copy.textBody, { productName })}\n\n${productUrl}\n`;

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
  const moqCopy = isMoqUnmetInquiry(inquiry);
  const title = moqCopy ? 'Now available for wholesale' : 'Back in stock';
  const body = moqCopy
    ? `${productName} now has enough stock for wholesale order. Tap to view and order.`
    : `${productName} is available again. Tap to view the product and order before it sells out.`;

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
            reason: moqCopy ? 'moq_unmet' : 'back_in_stock',
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
 * Process pending waitlist for a restocked / now-purchasable variant.
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
  const stock = {
    quantity: enriched.quantity,
    minimumOrderQuantity: enriched.minimumOrderQuantity,
    trackInventory: enriched.trackInventory,
  };

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
    .select('_id storefront reason')
    .lean();

  if (!pending.length) {
    return { attempted: 0, notified: 0, failed: 0, deferred: 0 };
  }

  let notified = 0;
  let failed = 0;
  let deferred = 0;
  let attempted = 0;

  for (const row of pending) {
    if (!shouldNotifyInquiryForStock(row, stock)) {
      deferred += 1;
      continue;
    }

    attempted += 1;
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
    quantity: stock.quantity,
    minimumOrderQuantity: stock.minimumOrderQuantity,
    pending: pending.length,
    attempted,
    notified,
    failed,
    deferred,
  });

  return { attempted, notified, failed, deferred };
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
  shouldNotifyInquiryForStock,
  notifyPendingInquiriesForRestock,
  notifyPendingInquiriesForRestocks,
  scheduleRestockNotifications,
  CLAIM_STALE_MS,
  MAX_PER_VARIANT,
};
