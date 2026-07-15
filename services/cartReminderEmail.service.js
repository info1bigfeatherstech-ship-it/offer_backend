const nodemailer = require('nodemailer');
const mongoose = require('mongoose');
const Cart = require('../models/cart');
const User = require('../models/User');
const cartReminderTemplate = require('../templates/cartReminderEmail.template');
const logger = require('../utils/logger');
const { findCartForStorefront } = require('./cartStorefront.service');
const { normalizeCustomerStorefront } = require('../utils/customerStorefrontScope');

const ADMIN_CART_PRODUCT_SELECT = 'name title slug variants';
const ADMIN_CART_POPULATE = [
  {
    path: 'items.productId',
    select: ADMIN_CART_PRODUCT_SELECT
  }
];

const MAX_BULK_RECIPIENTS = 50;
const SEND_DELAY_MS = 400;

let cachedTransporter = null;

/** Bulk cart-reminder mail uses MARKETING_EMAIL_* — not EMAIL_USER (OTP/auth). */
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
      'Marketing email is not configured. Set MARKETING_EMAIL_USER and MARKETING_EMAIL_PASSWORD on the server.'
    );
    err.code = 'EMAIL_NOT_CONFIGURED';
    throw err;
  }
  cachedTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass }
  });
  return cachedTransporter;
}

function getStorefrontCartUrl() {
  const base = String(process.env.FRONTEND_URL || process.env.STORE_URL || 'https://offerwalebaba.com').replace(
    /\/$/,
    ''
  );
  return `${base}/account/usercart`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatInr(amount) {
  const n = Number(amount) || 0;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(n);
}

function getItemUnitPrice(priceSnapshot) {
  if (!priceSnapshot) return 0;
  return priceSnapshot.sale ?? priceSnapshot.base ?? 0;
}

function ensureAbsoluteImageUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('//')) return `https:${raw}`;
  const base = String(
    process.env.MEDIA_CDN_BASE_URL || process.env.FRONTEND_URL || ''
  ).replace(/\/$/, '');
  if (!base) return raw;
  return `${base}${raw.startsWith('/') ? '' : '/'}${raw}`;
}

function resolveVariantImageUrl(variant) {
  const firstImg = Array.isArray(variant?.images) ? variant.images[0] : null;
  if (!firstImg) return null;
  let url = null;
  if (typeof firstImg === 'string') url = firstImg.trim() || null;
  else if (typeof firstImg === 'object') {
    url = String(firstImg.url || firstImg.secure_url || '').trim() || null;
  }
  return ensureAbsoluteImageUrl(url);
}

function formatCartItemRow(item) {
  const product = item.productId;
  const variant = product?.variants?.find((v) => String(v._id) === String(item.variantId));
  const unitPrice = getItemUnitPrice(item.priceSnapshot);
  const quantity = item.quantity || 1;
  const productName = product?.name || product?.title || 'Product';

  return {
    productName,
    imageUrl: resolveVariantImageUrl(variant),
    quantity,
    unitPrice,
    lineTotal: unitPrice * quantity
  };
}

function buildCartSummary(cartDoc) {
  const rows = (cartDoc?.items || []).map(formatCartItemRow).filter((r) => r.quantity > 0);
  const itemCount = rows.length;
  const totalAmount =
    cartDoc?.totalAmount != null && Number(cartDoc.totalAmount) > 0
      ? Number(cartDoc.totalAmount)
      : rows.reduce((sum, r) => sum + r.lineTotal, 0);

  return { rows, itemCount, totalAmount };
}

function applyPlaceholders(text, vars) {
  let out = String(text || '');
  Object.entries(vars).forEach(([key, value]) => {
    out = out.split(`{{${key}}}`).join(String(value ?? ''));
  });
  return out;
}

function buildCartItemPriceLabel(row) {
  if (row.quantity > 1) {
    return `${formatInr(row.unitPrice)} × ${row.quantity} = ${formatInr(row.lineTotal)}`;
  }
  return formatInr(row.lineTotal);
}

function buildCartItemsHtml(rows) {
  if (!rows.length) {
    return '<p style="color:#888;font-size:14px;">No items in cart.</p>';
  }
  const lines = rows
    .map((row) => {
      const safeName = escapeHtml(row.productName);
      const priceLabel = escapeHtml(buildCartItemPriceLabel(row));
      const imgUrl = row.imageUrl ? escapeHtml(row.imageUrl) : '';
      const imageCell = imgUrl
        ? `<img src="${imgUrl}" alt="${safeName}" width="64" height="64" style="display:block;width:64px;height:64px;object-fit:cover;border-radius:8px;border:1px solid #eee;" />`
        : `<div style="width:64px;height:64px;border-radius:8px;background:#f3f4f6;border:1px solid #e5e7eb;"></div>`;

      return `<tr>
        <td style="width:72px;padding:0 12px 12px 0;vertical-align:top;">${imageCell}</td>
        <td style="padding:0 0 12px 0;vertical-align:top;">
          <p style="margin:0;font-size:14px;font-weight:600;color:#1f2937;line-height:1.4;">${safeName}</p>
          <p style="margin:6px 0 0;font-size:14px;font-weight:600;color:#7c3aed;">${priceLabel}</p>
        </td>
      </tr>`;
    })
    .join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;">${lines}</table>`;
}

function buildCartItemsText(rows) {
  if (!rows.length) return 'No items in cart.';
  return rows
    .map((row) => `• ${row.productName} — ${buildCartItemPriceLabel(row)}`)
    .join('\n');
}

function buildEmailContent({ customerName, cartSummary }) {
  const { rows, itemCount, totalAmount } = cartSummary;
  const itemLabel = itemCount === 1 ? 'item' : 'items';
  const cartUrl = getStorefrontCartUrl();
  const cartItemsHtml = buildCartItemsHtml(rows);
  const displayName = customerName || 'there';

  const greetingText = applyPlaceholders(cartReminderTemplate.greeting, { name: displayName });

  const vars = {
    name: displayName,
    greeting: applyPlaceholders(cartReminderTemplate.greeting, { name: escapeHtml(displayName) }),
    intro: cartReminderTemplate.intro,
    itemCount: String(itemCount),
    itemLabel,
    cartTotal: formatInr(totalAmount),
    itemsSectionTitle: applyPlaceholders(cartReminderTemplate.itemsSectionTitle, {
      itemCount: String(itemCount),
      itemLabel,
      cartTotal: formatInr(totalAmount)
    }),
    cartItemsHtml,
    cartUrl,
    ctaLabel: cartReminderTemplate.ctaLabel,
    footer: cartReminderTemplate.footer
  };

  const html = applyPlaceholders(cartReminderTemplate.htmlLayout, vars);
  const text = [
    greetingText,
    '',
    cartReminderTemplate.intro,
    '',
    vars.itemsSectionTitle,
    buildCartItemsText(rows),
    '',
    `${cartReminderTemplate.ctaLabel}: ${cartUrl}`,
    '',
    cartReminderTemplate.footer
  ].join('\n');

  return {
    subject: cartReminderTemplate.subject,
    html,
    text
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send cart reminder emails to the given user IDs (scoped).
 * Skips users with empty carts or missing email.
 *
 * @param {{ userIds: string[], scopeQuery?: object }} params
 */
async function sendBulkCartReminderEmails({ userIds, scopeQuery = {} }) {
  const rawIds = Array.isArray(userIds) ? userIds : [];
  const uniqueIds = [...new Set(rawIds.map((id) => String(id || '').trim()).filter(Boolean))];

  if (!uniqueIds.length) {
    const err = new Error('At least one userId is required');
    err.code = 'USER_IDS_REQUIRED';
    throw err;
  }
  if (uniqueIds.length > MAX_BULK_RECIPIENTS) {
    const err = new Error(`Maximum ${MAX_BULK_RECIPIENTS} users per bulk send`);
    err.code = 'BULK_LIMIT_EXCEEDED';
    throw err;
  }

  const objectIds = uniqueIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
  if (!objectIds.length) {
    const err = new Error('No valid user IDs provided');
    err.code = 'INVALID_USER_IDS';
    throw err;
  }

  const users = await User.find({
    _id: { $in: objectIds },
    ...scopeQuery
  })
    .select('name email')
    .lean();

  const transporter = getTransporter();
  const from = getMarketingFromAddress();

  const results = {
    sent: 0,
    skipped: 0,
    failed: 0,
    details: []
  };

  const foundIds = new Set(users.map((u) => String(u._id)));

  for (let i = 0; i < users.length; i += 1) {
    const user = users[i];
    const userId = String(user._id);
    const email = String(user.email || '').trim().toLowerCase();

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      results.skipped += 1;
      results.details.push({ userId, status: 'skipped', reason: 'NO_VALID_EMAIL' });
      continue;
    }

    const cartDoc = await findCartForStorefront(user._id, 'ecomm').populate(ADMIN_CART_POPULATE).lean();
    const cartSummary = buildCartSummary(cartDoc);

    if (!cartSummary.itemCount) {
      results.skipped += 1;
      results.details.push({ userId, email, status: 'skipped', reason: 'EMPTY_CART' });
      continue;
    }

    try {
      const content = buildEmailContent({
        customerName: user.name,
        cartSummary
      });

      await transporter.sendMail({
        from,
        to: email,
        subject: content.subject,
        text: content.text,
        html: content.html
      });

      results.sent += 1;
      results.details.push({ userId, email, status: 'sent' });
    } catch (err) {
      logger.error('[cartReminderEmail] send failed', {
        userId,
        email,
        message: err?.message || String(err)
      });
      results.failed += 1;
      results.details.push({
        userId,
        email,
        status: 'failed',
        reason: err?.message || 'SEND_FAILED'
      });
    }

    if (i < users.length - 1) {
      await delay(SEND_DELAY_MS);
    }
  }

  uniqueIds.forEach((id) => {
    if (!foundIds.has(id)) {
      results.skipped += 1;
      results.details.push({ userId: id, status: 'skipped', reason: 'USER_NOT_IN_SCOPE_OR_NOT_FOUND' });
    }
  });

  return results;
}

module.exports = {
  sendBulkCartReminderEmails,
  MAX_BULK_RECIPIENTS
};
