const STOREFRONT_HEADER_ALIASES = [
  'x-storefront',
  'x-store-front',
  'x-storefrontend'
];

const CORS_STOREFRONT_ALLOWED_HEADERS = [
  'x-storefront',
  'X-Storefront',
  'X-Store-Front',
  'X-StoreFrontend',
  'Idempotency-Key',
  'idempotency-key'
];

module.exports = {
  STOREFRONT_HEADER_ALIASES,
  CORS_STOREFRONT_ALLOWED_HEADERS
};
