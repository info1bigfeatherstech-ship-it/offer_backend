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
 * Channels: email (marketing) + in-app website notifications + web push (opt-in devices).
 * Web push is storefront-aware via inquiry.storefront (PDP URL) and scoped user lookup.
 * Never blocks the inventory write path — callers should fire-and-forget.
 */
const nodemailer = require('nodemailer');
const OutOfStockInquiry = require('../models/OutOfStockInquiry');
const Product = require('../models/Product');
const logger = require('../utils/logger');
const template = require('../templates/oosRestockEmail.template');
const { buildStorefrontUrl, resolvePushAssetUrl } = require('../utils/storefrontFrontendUrl');
const {
  isPushConfigured,
  dispatchWebPush,
  delay: pushDelay,
} = require('../utils/webPushDispatch');

const SEND_DELAY_MS = Math.min(
  2000,
  Math.max(150, Number(process.env.OOS_RESTOCK_NOTIFY_DELAY_MS || 350))
);
const PUSH_DEVICE_DELAY_MS = Math.min(
  500,
  Math.max(50, Number(process.env.OOS_RESTOCK_PUSH_DEVICE_DELAY_MS || 100))
);
const MAX_PUSH_DEVICES_PER_USER = Math.min(
  10,
  Math.max(1, Number(process.env.OOS_RESTOCK_PUSH_MAX_DEVICES || 5))
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

function resolveInquiryStorefront(inquiry) {
  return inquiry?.storefront === 'wholesale' ? 'wholesale' : 'ecomm';
}

function buildProductUrl(inquiry) {
  const slug = String(inquiry.productSlug || '').trim();
  const sf = resolveInquiryStorefront(inquiry);
  if (!slug) return buildStorefrontUrl(sf, '/');
  return buildStorefrontUrl(sf, buildProductClickPath(slug, sf));
}

/**
 * Same-origin PDP path for web-push click (SW resolves against its registration origin).
 * ecomm → /products/:slug | wholesale → /product/:slug
 */
function buildProductClickPath(productSlug, storefront = 'ecomm') {
  const slug = String(productSlug || '').trim();
  if (!slug) return '/';
  // Reject path traversal / absolute URLs masquerading as slugs
  if (slug.includes('/') || slug.includes('\\') || slug.includes('..')) return '/';
  const prefix = storefront === 'wholesale' ? '/product' : '/products';
  return `${prefix}/${encodeURIComponent(slug)}`;
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
  const storefront = resolveInquiryStorefront(inquiry);

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
        notifyChannelErrors: [],
      },
      $inc: { notifyAttempts: 1 },
    },
    { new: true }
  );
}

async function markNotified(inquiryId, channels, channelErrors = []) {
  const errSummary = Array.isArray(channelErrors) && channelErrors.length
    ? channelErrors.join('; ').slice(0, 500)
    : null;
  await OutOfStockInquiry.updateOne(
    { _id: inquiryId, status: 'notifying' },
    {
      $set: {
        status: 'notified',
        notifiedAt: new Date(),
        // Keep soft channel failures visible even when another channel succeeded
        lastNotifyError: errSummary,
        notifyChannelsSent: channels,
        notifyChannelErrors: Array.isArray(channelErrors) ? channelErrors.slice(0, 20) : [],
      },
    }
  );
}

function classifyEmailError(err) {
  const msg = String(err?.message || err || '');
  const code = String(err?.code || '');
  const response = String(err?.response || '');
  const blob = `${code} ${msg} ${response}`.toLowerCase();
  if (
    blob.includes('daily user sending limit') ||
    blob.includes('5.4.5') ||
    blob.includes('sending limit')
  ) {
    const wrapped = new Error(
      'Marketing Gmail daily sending limit exceeded. Email skipped until quota resets.'
    );
    wrapped.code = 'EMAIL_QUOTA_EXCEEDED';
    return wrapped;
  }
  if (blob.includes('invalid login') || blob.includes('authentication') || code === 'EAUTH') {
    const wrapped = new Error(msg || 'Marketing email authentication failed');
    wrapped.code = 'EMAIL_AUTH_FAILED';
    return wrapped;
  }
  if (code === 'EENVELOPE' || code === 'EMESSAGE') {
    const wrapped = new Error(msg || 'Marketing email envelope rejected');
    wrapped.code = code;
    return wrapped;
  }
  if (err && typeof err === 'object') return err;
  const wrapped = new Error(msg || 'email_failed');
  wrapped.code = code || 'EMAIL_FAILED';
  return wrapped;
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
 * Resolve account for in-app + web push.
 * Prefers inquiry.userId, else match User by email/phone within inquiry storefront scope.
 */
async function resolveUserIdForInquiry(inquiry) {
  if (inquiry.userId) return inquiry.userId;
  const User = require('../models/User');
  const { buildCustomerContactLookup, customerScopeFromStorefront } = require('../utils/accountScope');
  const scope = customerScopeFromStorefront(resolveInquiryStorefront(inquiry));
  if (inquiry.email) {
    const byEmail = await User.findOne(
      buildCustomerContactLookup({ email: String(inquiry.email).toLowerCase() }, scope)
    )
      .select('_id')
      .lean();
    if (byEmail?._id) return byEmail._id;
  }
  if (inquiry.phone) {
    const byPhone = await User.findOne(
      buildCustomerContactLookup({ phone: String(inquiry.phone).trim() }, scope)
    )
      .select('_id')
      .lean();
    if (byPhone?._id) return byPhone._id;
  }
  return null;
}

/**
 * In-app notification in the website Notifications centre.
 * Uses synthetic orderId `oos:{inquiryId}` for idempotency with existing unique index.
 * @param {object} inquiry
 * @param {object} ctx
 * @param {unknown} [resolvedUserId]
 */
async function sendInAppRestockNotification(inquiry, ctx, resolvedUserId = null) {
  const userId =
    resolvedUserId != null ? resolvedUserId : await resolveUserIdForInquiry(inquiry);
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
            storefront: resolveInquiryStorefront(inquiry),
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
 * Browser / PWA web push for waitlist users who opted into notifications.
 * Soft channel: missing user / subscription / VAPID is a skip, not a hard outage.
 * @param {object} inquiry
 * @param {object} ctx
 * @param {unknown} [resolvedUserId]
 */
async function sendRestockWebPush(inquiry, ctx, resolvedUserId = null) {
  if (!envFlagEnabled('OOS_RESTOCK_WEB_PUSH_ENABLED', true)) {
    const err = new Error('OOS restock web push disabled');
    err.code = 'PUSH_DISABLED';
    throw err;
  }
  if (!isPushConfigured()) {
    const err = new Error('Web push is not configured (VAPID keys)');
    err.code = 'PUSH_NOT_CONFIGURED';
    throw err;
  }

  const userId =
    resolvedUserId != null ? resolvedUserId : await resolveUserIdForInquiry(inquiry);
  if (!userId) {
    const err = new Error('No user account linked for web push');
    err.code = 'PUSH_USER_MISSING';
    throw err;
  }

  const PushSubscription = require('../models/PushSubscription');
  let subscriptions = [];
  try {
    subscriptions = await PushSubscription.find({
      userId,
      isActive: true,
    }).limit(MAX_PUSH_DEVICES_PER_USER);
  } catch (err) {
    const wrapped = new Error(err?.message || 'Push subscription lookup failed');
    wrapped.code = 'PUSH_LOOKUP_FAILED';
    throw wrapped;
  }

  if (!subscriptions.length) {
    const err = new Error('No active push subscription for user');
    err.code = 'PUSH_NO_SUBSCRIPTION';
    throw err;
  }

  const sf = resolveInquiryStorefront(inquiry);
  const productNameRaw = String(ctx.productName || inquiry.productName || 'Your item')
    .trim()
    .replace(/["«»“”]/g, '')
    .replace(/\s+/g, ' ');
  // Title is the strongest OS surface — product in quotes; brand always present.
  const productNameForTitle = productNameRaw.slice(0, 44) || 'Your item';
  const productName = productNameRaw.slice(0, 120) || 'Your item';
  const productSlug = ctx.productSlug || inquiry.productSlug || null;
  const productUrl = buildProductUrl({
    ...(inquiry.toObject?.() || inquiry),
    productSlug,
    storefront: sf,
  });
  const clickPath = buildProductClickPath(productSlug, sf);
  const moqCopy = isMoqUnmetInquiry(inquiry);
  const titleTemplate = moqCopy
    ? template.moqPushTitle || '"{{productName}}" · Offer Wale Baba'
    : template.pushTitle || '"{{productName}}" · Offer Wale Baba';
  const bodyTemplate = moqCopy
    ? template.moqPushBody ||
      'Now available for wholesale on Offer Wale Baba. Tap to order.'
    : template.pushBody || 'Back in stock on Offer Wale Baba. Tap to view and order.';
  const title = fillTemplate(titleTemplate, { productName: productNameForTitle }).slice(0, 80);
  const body = fillTemplate(bodyTemplate, { productName }).slice(0, 180);
  const brandAssetPath =
    template.pushBadgePath || template.pushIconPath || '/pwa-192x192.png';
  const brandAssetUrl = resolvePushAssetUrl(brandAssetPath, sf);
  const tagPrefix = template.pushTagPrefix || 'oos-restock';
  const inquiryId = String(inquiry._id);

  // Restock web push: brand logo only (no large `image`).
  // OS notification "image" slots crop portrait product photos; logo + quoted title is clearer.
  // Click uses same-origin PDP path so SW opens this storefront's product page.
  const brandIcon = brandAssetUrl || '/pwa-192x192.png';
  const payload = {
    title: title || `"${productNameForTitle}" · Offer Wale Baba`.slice(0, 80),
    body:
      body ||
      (moqCopy
        ? 'Now available for wholesale on Offer Wale Baba. Tap to order.'
        : 'Back in stock on Offer Wale Baba. Tap to view and order.'),
    icon: brandIcon,
    badge: brandIcon,
    tag: `${tagPrefix}:${inquiryId}`.slice(0, 120),
    data: {
      type: 'back_in_stock',
      url: clickPath,
      absoluteUrl: productUrl,
      storefront: sf,
      inquiryId,
      productSlug: productSlug || null,
      productId: inquiry.productId ? String(inquiry.productId) : null,
    },
  };

  let devicesSent = 0;
  for (const sub of subscriptions) {
    try {
      const outcome = await dispatchWebPush(sub, payload, { logTag: 'oosRestockPush' });
      if (outcome?.ok) devicesSent += 1;
    } catch (err) {
      logger.warn('[oosRestockNotify] web push device send threw', {
        inquiryId,
        userId: String(userId),
        subscriptionId: String(sub?._id || ''),
        storefront: sf,
        message: err?.message || String(err),
      });
    }
    if (PUSH_DEVICE_DELAY_MS > 0) {
      await pushDelay(PUSH_DEVICE_DELAY_MS);
    }
  }

  if (!devicesSent) {
    const err = new Error('All web push devices failed or expired');
    err.code = 'PUSH_SEND_FAILED';
    throw err;
  }

  return { devicesSent };
}

/**
 * Deliver via email and/or in-app and/or web push. At least one channel must succeed.
 */
async function deliverInquiry(inquiry, ctx) {
  const channels = [];
  const errors = [];

  let resolvedUserId = null;
  try {
    resolvedUserId = await resolveUserIdForInquiry(inquiry);
  } catch (err) {
    logger.warn('[oosRestockNotify] user resolve failed', {
      inquiryId: String(inquiry._id),
      message: err?.message || String(err),
    });
  }

  if (inquiry.email) {
    try {
      await sendRestockEmail(inquiry, ctx);
      channels.push('email');
    } catch (rawErr) {
      const err = classifyEmailError(rawErr);
      errors.push(`email:${err.code || err.message}`);
      logger.warn('[oosRestockNotify] email failed', {
        inquiryId: String(inquiry._id),
        storefront: resolveInquiryStorefront(inquiry),
        to: String(inquiry.email || '').slice(0, 80),
        message: err.message,
        code: err.code,
      });
    }
  } else {
    errors.push('email:EMAIL_MISSING');
  }

  try {
    await sendInAppRestockNotification(inquiry, ctx, resolvedUserId);
    channels.push('in_app');
  } catch (err) {
    errors.push(`in_app:${err.code || err.message}`);
    logger.warn('[oosRestockNotify] in-app failed', {
      inquiryId: String(inquiry._id),
      storefront: resolveInquiryStorefront(inquiry),
      message: err.message,
      code: err.code,
    });
  }

  try {
    await sendRestockWebPush(inquiry, ctx, resolvedUserId);
    channels.push('web_push');
  } catch (err) {
    errors.push(`web_push:${err.code || err.message}`);
    const soft = [
      'PUSH_DISABLED',
      'PUSH_NOT_CONFIGURED',
      'PUSH_USER_MISSING',
      'PUSH_NO_SUBSCRIPTION',
    ].includes(err.code);
    if (soft) {
      logger.info('[oosRestockNotify] web push skipped', {
        inquiryId: String(inquiry._id),
        storefront: resolveInquiryStorefront(inquiry),
        code: err.code,
        message: err.message,
      });
    } else {
      logger.warn('[oosRestockNotify] web push failed', {
        inquiryId: String(inquiry._id),
        storefront: resolveInquiryStorefront(inquiry),
        message: err.message,
        code: err.code,
      });
    }
  }

  if (!channels.length) {
    const err = new Error(errors.join('; ') || 'No channel succeeded');
    err.code = 'ALL_CHANNELS_FAILED';
    err.channelErrors = errors;
    throw err;
  }

  return { channels, channelErrors: errors };
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
      const result = await deliverInquiry(claimed, enriched);
      const channels = Array.isArray(result) ? result : result?.channels || [];
      const channelErrors = Array.isArray(result?.channelErrors) ? result.channelErrors : [];
      await markNotified(claimed._id, channels, channelErrors);
      notified += 1;
    } catch (err) {
      failed += 1;
      const detail = Array.isArray(err?.channelErrors) && err.channelErrors.length
        ? err.channelErrors.join('; ')
        : err.message;
      await releaseClaim(claimed._id, detail);
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
