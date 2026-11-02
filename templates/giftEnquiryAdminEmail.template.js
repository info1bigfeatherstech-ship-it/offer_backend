module.exports = {
  subject: 'New {{enquiryLabel}} enquiry from {{name}}',

  htmlLayout: `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;padding:24px;border:1px solid #eee;border-radius:10px;">
  <h2 style="margin:0 0 12px 0;color:#1a1a1a;font-size:20px;">New gifting enquiry</h2>
  <p style="color:#555;line-height:1.6;margin:0 0 16px 0;">A customer submitted a {{enquiryLabel}} enquiry.</p>
  <table style="width:100%;border-collapse:collapse;margin:0 0 16px 0;font-size:14px;color:#333;">
    <tr><td style="padding:6px 0;color:#777;width:180px;">Name</td><td style="padding:6px 0;">{{name}}</td></tr>
    <tr><td style="padding:6px 0;color:#777;">Email</td><td style="padding:6px 0;">{{email}}</td></tr>
    <tr><td style="padding:6px 0;color:#777;">Phone</td><td style="padding:6px 0;">{{phone}}</td></tr>
    <tr><td style="padding:6px 0;color:#777;">Organization</td><td style="padding:6px 0;">{{organizationName}}</td></tr>
    <tr><td style="padding:6px 0;color:#777;">City</td><td style="padding:6px 0;">{{city}}</td></tr>
    <tr><td style="padding:6px 0;color:#777;">Occasion</td><td style="padding:6px 0;">{{occasion}}</td></tr>
    <tr><td style="padding:6px 0;color:#777;">Gift category</td><td style="padding:6px 0;">{{giftCategory}}</td></tr>
    <tr><td style="padding:6px 0;color:#777;">Quantity</td><td style="padding:6px 0;">{{quantity}}</td></tr>
    <tr><td style="padding:6px 0;color:#777;">Business type</td><td style="padding:6px 0;">{{businessType}}</td></tr>
    <tr><td style="padding:6px 0;color:#777;">Volume order</td><td style="padding:6px 0;">{{volumeOrder}}</td></tr>
    <tr><td style="padding:6px 0;color:#777;">Delivery date</td><td style="padding:6px 0;">{{targetDeliveryDate}}</td></tr>
    <tr><td style="padding:6px 0;color:#777;">Enquiry id</td><td style="padding:6px 0;">{{id}}</td></tr>
  </table>
  <p style="color:#333;font-weight:600;margin:16px 0 8px 0;">Message</p>
  <p style="color:#555;line-height:1.6;margin:0 0 16px 0;white-space:pre-wrap;">{{message}}</p>
  <p style="color:#333;font-weight:600;margin:16px 0 8px 0;">Files</p>
  <div style="color:#555;line-height:1.6;margin:0 0 8px 0;">{{filesHtml}}</div>
</div>
`.trim(),

  textBody: `New {{enquiryLabel}} enquiry

Name: {{name}}
Email: {{email}}
Phone: {{phone}}
Organization: {{organizationName}}
City: {{city}}
Occasion: {{occasion}}
Gift category: {{giftCategory}}
Quantity: {{quantity}}
Business type: {{businessType}}
Volume order: {{volumeOrder}}
Delivery date: {{targetDeliveryDate}}
Enquiry id: {{id}}

Message:
{{message}}

Files:
{{filesText}}`,
};
