/**
 * Checkout-time fulfilment automation (Shiprocket + orderStatus).
 *
 * Phase 1 Option A (default): new orders stay `orderStatus: "pending"` for the admin queue.
 * Shiprocket forward orders are not created on COD placement, payment verify, or Razorpay webhook;
 * admin APIs (`ensureShipmentForOrderExport`) remain the supported path when ops enable it later.
 *
 * Set env `LEGACY_AUTO_FULFILL_ON_CHECKOUT=true` only to restore previous behaviour
 * (auto Shiprocket after eligible payment/COD, and promote to `confirmed` when payment settles / COD placed).
 */
function isLegacyAutoFulfillOnCheckout() {
  const v = String(process.env.LEGACY_AUTO_FULFILL_ON_CHECKOUT || '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

module.exports = {
  isLegacyAutoFulfillOnCheckout
};
