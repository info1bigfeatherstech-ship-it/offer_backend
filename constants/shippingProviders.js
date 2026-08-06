/**
 * Dual shipping providers: Shiprocket (existing) + Shipmozo.
 * Active setting governs NEW orders only; each order freezes shippingProvider forever.
 */

const SHIPPING_PROVIDERS = Object.freeze({
  SHIPROCKET: 'shiprocket',
  SHIPMOZO: 'shipmozo'
});

const SHIPPING_PROVIDER_SET = new Set(Object.values(SHIPPING_PROVIDERS));

/** Default when unset / legacy orders without stamp */
const DEFAULT_SHIPPING_PROVIDER = SHIPPING_PROVIDERS.SHIPROCKET;

/**
 * @param {unknown} value
 * @returns {'shiprocket'|'shipmozo'|null}
 */
function normalizeShippingProvider(value) {
  const s = String(value || '')
    .toLowerCase()
    .trim();
  return SHIPPING_PROVIDER_SET.has(s) ? s : null;
}

/**
 * Resolve provider for an existing order. Legacy (missing field) → shiprocket.
 * @param {object|null|undefined} order
 */
function resolveOrderShippingProvider(order) {
  const stamped = normalizeShippingProvider(order?.shippingProvider);
  if (stamped) return stamped;
  // Heuristic: shipmozo ids without stamp
  if (order?.shipmentInfo?.shipmozoOrderId || order?.shipmentInfo?.shipmozoReferenceId) {
    return SHIPPING_PROVIDERS.SHIPMOZO;
  }
  return DEFAULT_SHIPPING_PROVIDER;
}

function isShipmozoOrder(order) {
  return resolveOrderShippingProvider(order) === SHIPPING_PROVIDERS.SHIPMOZO;
}

function isShiprocketOrder(order) {
  return resolveOrderShippingProvider(order) === SHIPPING_PROVIDERS.SHIPROCKET;
}

module.exports = {
  SHIPPING_PROVIDERS,
  SHIPPING_PROVIDER_SET,
  DEFAULT_SHIPPING_PROVIDER,
  normalizeShippingProvider,
  resolveOrderShippingProvider,
  isShipmozoOrder,
  isShiprocketOrder
};
