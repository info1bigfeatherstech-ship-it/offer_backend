/**
 * Cart reminder email copy — edit this file to change messaging for all future sends.
 * Per-customer cart items, totals, and names are injected automatically at send time.
 *
 * Placeholders (replaced per recipient):
 *   {{name}}           Customer display name
 *   {{itemCount}}      Number of line items in cart
 *   {{itemLabel}}      "item" or "items"
 *   {{cartTotal}}      Formatted cart total (INR)
 *   {{cartItemsHtml}}  HTML list of cart lines (built by the mail service)
 *   {{cartUrl}}        Link to storefront cart page
 */

module.exports = {
  subject: 'Your cart is waiting at OfferWaaleBaba',

  greeting: 'Hi {{name}},',

  intro:
    'You left great picks in your cart on OfferWaaleBaba. These items are still waiting for you — complete your order before they go out of stock!',

  itemsSectionTitle: 'Your cart ({{itemCount}} {{itemLabel}} · {{cartTotal}})',

  ctaLabel: 'Go to cart & place order',

  footer:
    'If you already placed this order, you can ignore this email. Need help? Contact our support team.',

  htmlLayout: `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;padding:24px;border:1px solid #eee;border-radius:10px;">
  <h2 style="margin:0 0 12px 0;color:#1a1a1a;font-size:20px;">OfferWaaleBaba</h2>
  <p style="color:#444;line-height:1.6;margin:0 0 12px 0;">{{greeting}}</p>
  <p style="color:#555;line-height:1.6;margin:0 0 20px 0;">{{intro}}</p>
  <p style="font-weight:600;color:#333;margin:0 0 8px 0;">{{itemsSectionTitle}}</p>
  <div style="margin:0 0 20px 0;">{{cartItemsHtml}}</div>
  <p style="margin:24px 0;">
    <a href="{{cartUrl}}" style="display:inline-block;background:#7c3aed;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;">{{ctaLabel}}</a>
  </p>
  <p style="color:#888;font-size:13px;line-height:1.5;margin:24px 0 0 0;">{{footer}}</p>
</div>
`.trim()
};
