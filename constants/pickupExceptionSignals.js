/**
 * Shared Shiprocket pickup-exception signal pattern.
 * Keep dependency-free so shipmentOps + admin query helpers can both import it
 * without circular requires.
 */

/**
 * Case-insensitive match for Shiprocket pickup-exception carrier labels.
 * Used by normalizeProviderSignals classification and admin Pickup Exception bucketing.
 */
const PICKUP_EXCEPTION_PROVIDER_STATUS_REGEX =
  'pickup\\s*exception|pickup\\s*failed|pickup\\s*error|pickup\\s*not\\s*completed|wrong\\s*courier';

module.exports = {
  PICKUP_EXCEPTION_PROVIDER_STATUS_REGEX
};
