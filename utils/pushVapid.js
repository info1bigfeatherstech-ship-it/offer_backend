/**
 * VAPID env helpers — shared by cart push send + leads settings (avoids circular requires).
 */

function getVapidPublicKey() {
  return String(process.env.VAPID_PUBLIC_KEY || '').trim();
}

function getVapidPrivateKey() {
  return String(process.env.VAPID_PRIVATE_KEY || '').trim();
}

function getVapidSubject() {
  const subject = String(process.env.VAPID_SUBJECT || '').trim();
  if (subject) return subject;
  const marketingEmail = String(process.env.MARKETING_EMAIL_USER || '').trim();
  if (marketingEmail) return `mailto:${marketingEmail}`;
  const otpEmail = String(process.env.EMAIL_USER || '').trim();
  if (otpEmail) return `mailto:${otpEmail}`;
  return 'mailto:support@offerwalebaba.com';
}

function isPushConfigured() {
  return Boolean(getVapidPublicKey() && getVapidPrivateKey());
}

module.exports = {
  getVapidPublicKey,
  getVapidPrivateKey,
  getVapidSubject,
  isPushConfigured,
};
