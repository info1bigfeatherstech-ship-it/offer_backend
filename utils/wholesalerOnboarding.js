/**
 * Wholesaler two-phase onboarding helpers (basic interest → owner approve → full details → OTP).
 * Legacy requests that already stored full KYC are treated as details-complete.
 */

function normalizeWholesalerPhone(v) {
  return String(v || '').replace(/\D/g, '').slice(-10);
}

function normalizeWholesalerEmail(v) {
  return String(v || '').trim().toLowerCase();
}

/**
 * Whether business / KYC fields are present enough to allow activation OTP.
 * @param {object|null|undefined} doc
 */
function isWholesalerDetailsComplete(doc) {
  if (!doc) return false;
  if (doc.detailsSubmittedAt) return true;

  const permanentAddress = String(doc.permanentAddress || '').trim();
  const businessAddress = String(doc.businessAddress || '').trim();
  const deliveryAddress = String(doc.deliveryAddress || '').trim();
  const sellingPlaceFrom = String(doc.sellingPlaceFrom || '').trim();
  const sellingZoneCity = String(doc.sellingZoneCity || '').trim();
  const productCategory = String(doc.productCategory || '').trim();
  const monthly = Number(doc.monthlyEstimatedPurchase);
  const idProof = String(doc.idProofUpload || '').trim();
  const bizProof = String(doc.businessAddressProofUpload || '').trim();

  return Boolean(
    permanentAddress &&
      businessAddress &&
      deliveryAddress &&
      sellingPlaceFrom &&
      sellingZoneCity &&
      productCategory &&
      Number.isFinite(monthly) &&
      monthly >= 0 &&
      idProof &&
      bizProof
  );
}

/**
 * Raw body (+ optional resolved proof URLs) looks like a legacy one-shot full application.
 * @param {object} body
 * @param {{ idProofUpload?: string, businessAddressProofUpload?: string }} [proofs]
 */
function looksLikeFullWholesalerPayload(body, proofs = {}) {
  const b = body || {};
  const permanentAddress = String(b.permanentAddress || '').trim();
  const businessAddress = String(b.businessAddress || '').trim();
  const deliveryAddress = String(b.deliveryAddress || '').trim();
  const sellingPlaceFrom = String(b.sellingPlaceFrom || '').trim();
  const sellingZoneCity = String(b.sellingZoneCity || '').trim();
  const productCategory = String(b.productCategory || '').trim();
  const monthlyRaw = b.monthlyEstimatedPurchase;
  const monthlyOk =
    monthlyRaw !== undefined &&
    monthlyRaw !== null &&
    String(monthlyRaw).trim() !== '' &&
    Number.isFinite(Number(monthlyRaw));
  const idProof = String(proofs.idProofUpload || b.idProofUpload || '').trim();
  const bizProof = String(proofs.businessAddressProofUpload || b.businessAddressProofUpload || '').trim();

  return Boolean(
    permanentAddress &&
      businessAddress &&
      deliveryAddress &&
      sellingPlaceFrom &&
      sellingZoneCity &&
      productCategory &&
      monthlyOk &&
      idProof &&
      bizProof
  );
}

/**
 * @param {object} doc
 */
function wholesalerOnboardingFlags(doc) {
  const status = String(doc?.status || '');
  const detailsComplete = isWholesalerDetailsComplete(doc);
  return {
    status,
    detailsComplete,
    canCompleteDetails: status === 'approved' && !detailsComplete,
    canRequestActivationOtp: status === 'approved' && detailsComplete,
    onboardingPhase: detailsComplete ? 'details_complete' : 'basic_only'
  };
}

module.exports = {
  normalizeWholesalerPhone,
  normalizeWholesalerEmail,
  isWholesalerDetailsComplete,
  looksLikeFullWholesalerPayload,
  wholesalerOnboardingFlags
};
