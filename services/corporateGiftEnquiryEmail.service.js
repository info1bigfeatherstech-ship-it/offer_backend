/**
 * Gift-enquiry mail: customer acknowledgement + internal notify.
 * Never throws to the HTTP handler — callers enqueue this after persist.
 */

const nodemailer = require('nodemailer');
const logger = require('../utils/logger');
const { getStorefrontFrontendBase } = require('../utils/storefrontFrontendUrl');
const customerTpl = require('../templates/giftEnquiryCustomerEmail.template');
const adminTpl = require('../templates/giftEnquiryAdminEmail.template');

let cachedTransporter = null;

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fillTemplate(template, vars) {
  return String(template || '').replace(/\{\{(\w+)\}\}/g, (_, key) =>
    vars[key] == null ? '' : String(vars[key])
  );
}

function enquiryLabel(type) {
  return type === 'bulk' ? 'bulk gifting' : 'customised gifting';
}

function formatYmd(date) {
  if (!date) return '—';
  try {
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toISOString().slice(0, 10);
  } catch {
    return '—';
  }
}

function getTransporter() {
  if (cachedTransporter) return cachedTransporter;
  const user = String(process.env.EMAIL_USER || '').trim();
  const pass = String(process.env.EMAIL_PASSWORD || '').trim();
  if (!user || !pass) {
    const err = new Error('Email transport not configured: set EMAIL_USER and EMAIL_PASSWORD.');
    err.code = 'EMAIL_NOT_CONFIGURED';
    throw err;
  }
  cachedTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });
  return cachedTransporter;
}

function resolveNotifyEmail() {
  return (
    String(process.env.GIFT_ENQUIRY_NOTIFY_EMAIL || '').trim() ||
    String(process.env.EMAIL_USER || '').trim()
  );
}

function buildFileRows(enquiry) {
  const logos = Array.isArray(enquiry.logos) ? enquiry.logos : [];
  const refs = Array.isArray(enquiry.referencePhotos) ? enquiry.referencePhotos : [];
  const card = enquiry.businessCard && enquiry.businessCard.url ? [enquiry.businessCard] : [];
  const all = [...refs, ...logos, ...card];
  if (!all.length) {
    return { filesHtml: 'No files attached.', filesText: 'No files attached.' };
  }
  const filesHtml = all
    .map((f) => {
      const label = escapeHtml(f.originalName || f.kind || 'file');
      const kind = escapeHtml(f.kind || 'file');
      const url = escapeHtml(f.url || '');
      return `<div style="margin:0 0 6px 0;">${kind}: <a href="${url}">${label}</a></div>`;
    })
    .join('');
  const filesText = all
    .map((f) => `${f.kind || 'file'}: ${f.originalName || 'file'} — ${f.url || ''}`)
    .join('\n');
  return { filesHtml, filesText };
}

function commonVars(enquiry) {
  const storefront = enquiry.storefront === 'wholesale' ? 'wholesale' : 'ecomm';
  return {
    id: String(enquiry._id || enquiry.id || ''),
    name: escapeHtml(enquiry.name || 'there'),
    phone: escapeHtml(enquiry.phone || ''),
    organizationName: escapeHtml(enquiry.organizationName || '—'),
    city: escapeHtml(enquiry.city || '—'),
    occasion: escapeHtml(enquiry.occasion || '—'),
    giftCategory: escapeHtml(enquiry.giftCategory || '—'),
    quantity: escapeHtml(enquiry.quantity == null ? '—' : String(enquiry.quantity)),
    volumeOrder: escapeHtml(enquiry.volumeOrder == null ? '—' : String(enquiry.volumeOrder)),
    businessType: escapeHtml(enquiry.businessType || '—'),
    targetDeliveryDate: escapeHtml(formatYmd(enquiry.targetDeliveryDate)),
    message: escapeHtml(enquiry.message || '—'),
    email: escapeHtml(enquiry.email || '—'),
    enquiryLabel: escapeHtml(enquiryLabel(enquiry.enquiryType)),
    storeUrl: escapeHtml(getStorefrontFrontendBase(storefront)),
  };
}

async function sendMail(options) {
  const transporter = getTransporter();
  return transporter.sendMail({
    from: `"OfferWaleBaba" <${process.env.EMAIL_USER}>`,
    ...options,
  });
}

async function sendCustomerAckEmail(enquiry) {
  const to = String(enquiry.email || '').trim().toLowerCase();
  if (!to) return;
  const vars = commonVars(enquiry);
  await sendMail({
    to,
    subject: fillTemplate(customerTpl.subject, vars),
    text: fillTemplate(customerTpl.textBody, vars),
    html: fillTemplate(customerTpl.htmlLayout, vars),
  });
}

async function sendAdminNotifyEmail(enquiry) {
  const to = resolveNotifyEmail();
  if (!to) return;
  const vars = { ...commonVars(enquiry), ...buildFileRows(enquiry) };
  await sendMail({
    to,
    replyTo: enquiry.email || undefined,
    subject: fillTemplate(adminTpl.subject, vars),
    text: fillTemplate(adminTpl.textBody, vars),
    html: fillTemplate(adminTpl.htmlLayout, vars),
  });
}

function enqueueGiftEnquiryEmails(enquiry) {
  setImmediate(() => {
    Promise.resolve()
      .then(async () => {
        try {
          await sendCustomerAckEmail(enquiry);
        } catch (err) {
          logger.error('[gift-enquiry] customer ack email failed', {
            id: String(enquiry._id || ''),
            message: err.message,
          });
        }
        try {
          await sendAdminNotifyEmail(enquiry);
        } catch (err) {
          logger.error('[gift-enquiry] admin notify email failed', {
            id: String(enquiry._id || ''),
            message: err.message,
          });
        }
      })
      .catch((err) => {
        logger.error('[gift-enquiry] email queue failed', { message: err.message });
      });
  });
}

module.exports = {
  enqueueGiftEnquiryEmails,
  sendCustomerAckEmail,
  sendAdminNotifyEmail,
};
