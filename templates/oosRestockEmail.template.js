/**
 * Back-in-stock email + web-push copy for OOS inquiry waitlist.
 * Placeholders: {{productName}}, {{productUrl}}, {{ctaLabel}}, {{greeting}}, {{intro}}, {{stockLine}}, {{footer}}
 */
module.exports = {
  subject: '{{productName}} is back in stock at OfferWaaleBaba',

  greeting: 'Good news!',

  intro:
    'The item you asked about is available again. Grab it soon — popular products can sell out quickly.',

  ctaLabel: 'View product & buy',

  footer:
    'You received this because you asked to be notified when this product was back in stock. If you already bought it, you can ignore this email.',

  // Web push (browser / PWA) — product name in title (OS often bold), brand always in copy.
  // icon prefers product image at send-time; badge stays brand logo.
  pushBrandName: 'Offer Wale Baba',
  pushTitle: '{{productName}} · Offer Wale Baba',
  pushBody: 'Back in stock on Offer Wale Baba. Tap to view and order.',
  pushBadgePath: '/pwa-192x192.png',
  pushIconPath: '/pwa-192x192.png',
  pushTagPrefix: 'oos-restock',

  // Wholesale MOQ waitlist (reason = moq_unmet)
  moqSubject: '{{productName}} is now available for wholesale order',
  moqGreeting: 'Good news!',
  moqIntro:
    'Enough stock is now available to meet the wholesale minimum order quantity. Place your order while stock lasts.',
  moqStockLine: '<strong>{{productName}}</strong> is now available for wholesale order.',
  moqCtaLabel: 'View product & order',
  moqFooter:
    'You received this because you asked to be notified when this product had enough wholesale stock. If you already ordered, you can ignore this email.',
  moqTextBody:
    '{{productName}} is now available for wholesale order.\nEnough stock is now available to meet the wholesale minimum order quantity.',
  moqPushTitle: '{{productName}} · Offer Wale Baba',
  moqPushBody: 'Now available for wholesale on Offer Wale Baba. Tap to order.',

  htmlLayout: `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;padding:24px;border:1px solid #eee;border-radius:10px;">
  <h2 style="margin:0 0 12px 0;color:#1a1a1a;font-size:20px;">OfferWaaleBaba</h2>
  <p style="color:#444;line-height:1.6;margin:0 0 8px 0;font-weight:600;">{{greeting}}</p>
  <p style="color:#555;line-height:1.6;margin:0 0 16px 0;">
    {{stockLine}}
  </p>
  <p style="color:#555;line-height:1.6;margin:0 0 20px 0;">{{intro}}</p>
  <p style="margin:24px 0;">
    <a href="{{productUrl}}" style="display:inline-block;background:#F7A221;color:#111;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;">{{ctaLabel}}</a>
  </p>
  <p style="color:#888;font-size:13px;line-height:1.5;margin:24px 0 0 0;">{{footer}}</p>
</div>
`.trim(),
};

