# Dropshipper module

Isolated backend for dropshipping. Does **not** change ecomm/wholesale cart, checkout, or catalog filters.

- Phase 1: admin product dropship visibility & pricing  
- Phase 2: serviceability (warehouse → customer)  
- Later: login / subscription / create order  

---

## Phase 1 — Admin product APIs

**Base:** `/api/admin/dropshipper`  
**Auth:** Bearer JWT + `admin` | `product_manager` (list also: `inventory_manager`)

| Method | Path | Body / Query |
|--------|------|----------------|
| GET | `/products?page&limit&listedOnly&q` | — |
| GET | `/products/:slug` | — |
| PATCH | `/products/:slug/variants/:productCode/price` | `{ dropshipBase, enable? }` |
| PATCH | `/products/:slug/variants/:productCode/enable` | `{ dropshipBase? }` |
| PATCH | `/products/:slug/variants/:productCode/disable` | `{ clearPrice? }` |
| POST | `/products/bulk-enable` | `{ items: [{ productCode, slug?, dropshipBase? }] }` |
| POST | `/products/bulk-set-price` | `{ items: [{ productCode, dropshipBase, slug?, enable? }] }` |

**Rules**
- Enable needs `dropshipBase > 0` (or pass it in the same request).
- Bulk enable: missing price → **skip + report**, batch continues.
- Existing create/bulk product APIs unchanged; manage dropship via these routes only.

---

## Phase 2 — Serviceability

**Base:** `/api/dropshipper`  
**Auth (temporary until dropshipper login):** Bearer JWT + `admin` | `product_manager` | `inventory_manager`  
(Non-prod only: `DROPSHIPPER_AUTH_BYPASS=true`)

### `POST /api/dropshipper/serviceability/check`

**Request body**

```json
{
  "customerPincode": "110001",
  "warehousePincode": "560001",
  "weightKg": 0.5,
  "lengthCm": 10,
  "widthCm": 10,
  "heightCm": 5,
  "paymentMode": "both",
  "orderAmount": 999,
  "storefront": "ecomm"
}
```

| Field | Required | Notes |
|-------|----------|--------|
| `customerPincode` | yes | 6-digit (aliases: `deliveryPincode`, `pincode`) |
| `warehousePincode` | yes | 6-digit pickup (alias: `pickupPincode`) |
| `weightKg` | yes | kg, min 0.05 (alias: `weight`) |
| `lengthCm` | yes | aliases: `length`, `l` |
| `widthCm` | yes | breadth — aliases: `breadthCm`, `breadth`, `width`, `b` |
| `heightCm` | yes | aliases: `height`, `h` |
| `paymentMode` | no | `prepaid` \| `cod` \| `both` (default `both`) |
| `orderAmount` | no | COD declared value; recommended when checking COD |
| `storefront` | no | `ecomm` \| `wholesale` — which provider settings to use (default `ecomm`) |

**Success response (shape)**

```json
{
  "success": true,
  "message": "Delivery available for this route",
  "customerPincode": "110001",
  "warehousePincode": "560001",
  "package": { "weightKg": 0.5, "lengthCm": 10, "widthCm": 10, "heightCm": 5 },
  "paymentMode": "both",
  "orderAmount": 999,
  "storefront": "ecomm",
  "isDeliverable": true,
  "estimatedDays": "3–5",
  "deliveryCharges": 80,
  "shippingProvider": "shiprocket",
  "quotes": {
    "prepaid": {
      "isDeliverable": true,
      "deliveryCharges": 80,
      "freightInr": 80,
      "codFeeInr": 0,
      "estimatedDays": "3–5",
      "courierName": "…",
      "courierCompanyId": "…",
      "codAvailable": false,
      "message": "Delivery available",
      "code": null,
      "mock": false,
      "shippingProvider": "shiprocket"
    },
    "cod": {
      "isDeliverable": true,
      "deliveryCharges": 95,
      "freightInr": 80,
      "codFeeInr": 15,
      "estimatedDays": "3–5",
      "courierName": "…",
      "codAvailable": true,
      "message": "Delivery available",
      "shippingProvider": "shiprocket"
    }
  }
}
```

**Frontend usage**
1. Form: customer pin + warehouse pin + weight + L/B/H + optional order amount.
2. Call with `paymentMode: "both"`.
3. Show prepaid vs COD charges from `quotes.prepaid` / `quotes.cod`.
4. Let user select prepaid or COD; use that quote’s `deliveryCharges` + `estimatedDays`.
5. If `isDeliverable === false` (or selected quote), show `message` / not serviceable.

**Validation errors:** `400` + `code: INVALID_PINCODE | VALIDATION_ERROR`

---

## Out of scope (later)

- Dropshipper register / login / subscription fee  
- Dropshipper product catalog (public list of dropship-active products)  
- Create order + Razorpay  
- Admin dropshipper-orders filter  

Ecomm `/api/delivery/*` routes are unchanged.
