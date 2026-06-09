/**
 * Cart reminder web push copy — edit for all manual + auto push sends.
 * Placeholders replaced at send time: {{name}}, {{itemCount}}, {{itemLabel}}, {{cartTotal}}
 */

module.exports = {
  title: 'Your cart is waiting',
  body:
    'Hi {{name}}, you have {{itemCount}} {{itemLabel}} ({{cartTotal}}) in your cart on OfferWaaleBaba. Complete your order before they go out of stock!',
  icon: '/pwa-192x192.png',
  badge: '/pwa-192x192.png',
  tag: 'cart-reminder',
};
