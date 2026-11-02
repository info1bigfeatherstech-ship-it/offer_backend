module.exports = {
  subject: 'We received your gifting enquiry — OfferWaleBaba',

  htmlLayout: `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;padding:24px;border:1px solid #eee;border-radius:10px;">
  <h2 style="margin:0 0 12px 0;color:#1a1a1a;font-size:20px;">OfferWaaleBaba</h2>
  <p style="color:#444;line-height:1.6;margin:0 0 12px 0;">Hi {{name}},</p>
  <p style="color:#555;line-height:1.6;margin:0 0 16px 0;">
    Thank you for your {{enquiryLabel}} enquiry. Our team has received your details and will get in touch shortly.
  </p>
  <table style="width:100%;border-collapse:collapse;margin:0 0 20px 0;font-size:14px;color:#333;">
    <tr><td style="padding:6px 0;color:#777;width:160px;">Enquiry</td><td style="padding:6px 0;">{{enquiryLabel}}</td></tr>
    <tr><td style="padding:6px 0;color:#777;">Occasion</td><td style="padding:6px 0;">{{occasion}}</td></tr>
    <tr><td style="padding:6px 0;color:#777;">Gift category</td><td style="padding:6px 0;">{{giftCategory}}</td></tr>
    <tr><td style="padding:6px 0;color:#777;">Quantity</td><td style="padding:6px 0;">{{quantity}}</td></tr>
    <tr><td style="padding:6px 0;color:#777;">City</td><td style="padding:6px 0;">{{city}}</td></tr>
  </table>
  <p style="margin:24px 0;">
    <a href="{{storeUrl}}" style="display:inline-block;background:#F7A221;color:#111;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;">Visit OfferWaleBaba</a>
  </p>
  <p style="color:#888;font-size:13px;line-height:1.5;margin:24px 0 0 0;">
    If you did not submit this enquiry, you can ignore this email.
  </p>
</div>
`.trim(),

  textBody: `Hi {{name}},

Thank you for your {{enquiryLabel}} enquiry. Our team has received your details and will get in touch shortly.

Occasion: {{occasion}}
Gift category: {{giftCategory}}
Quantity: {{quantity}}
City: {{city}}

{{storeUrl}}

— OfferWaleBaba`,
};
