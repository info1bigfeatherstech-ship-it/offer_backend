/**
 * RTO customer notification copy + policy URL.
 */
const DEFAULT_POLICY_URL = 'https://offerwalebaba.com/policies/return-refund';

function getRtoRefundPolicyUrl() {
  const raw = String(process.env.RTO_REFUND_POLICY_URL || '').trim();
  return raw || DEFAULT_POLICY_URL;
}

module.exports = {
  getRtoRefundPolicyUrl,
  DEFAULT_POLICY_URL
};
