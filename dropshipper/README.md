# Dropshipper module

Isolated backend for dropshipping. Does **not** change ecomm/wholesale cart, checkout, or catalog filters.

- Phase 1: admin product dropship visibility & pricing  
- Phase 2: serviceability (warehouse → customer)  
- Phase 3: dropshipper catalog  
- Phase 4: create order + Razorpay (online only) + admin dropship order list  
- Later: login / subscription  

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

---

## Phase 2 — Serviceability

**Base:** `/api/dropshipper`  
**Auth (temporary until dropshipper login):** Bearer JWT + `admin` | `product_manager` | `inventory_manager`  
(Non-prod only: `DROPSHIPPER_AUTH_BYPASS=true`)

### `POST /api/dropshipper/serviceability/check`

See earlier docs — use `paymentMode: "prepaid"` before placing (COD not used for dropship checkout).

---

## Phase 3 — Catalog

| Method | Path | Notes |
|--------|------|--------|
| GET | `/catalog/products?page&limit&q&categoryId&inStockOnly&sort` | Only dropship-listed variants |
| GET | `/catalog/products/:slug` | Detail; dropship variants only |
| GET | `/catalog/variants/:productCode` | Single variant detail |
| GET | `/catalog/variants/:productCode/download-pack` | JSON pack for FE download |

**Payable field:** `dropshipPrice` only (from `price.dropshipBase`).

---

## Phase 4 — Create order + Razorpay (online only)

**Base:** `/api/dropshipper`  
**Auth:** same temporary staff JWT as catalog  

Orders are saved with `storefront: "dropship"` and public ids `OWB-DS-######`.  
They **never** appear in the default ecomm/wholesale admin order lists.  
Fulfillment reuse: send admin header `x-storefront: dropship` on existing admin order APIs (ecomm staff with ecomm scope are auto-granted dropship scope at runtime).

### `POST /api/dropshipper/orders/quote`

Preview pricing + optional shipping (when pincodes provided).

```json
{
  "items": [{ "productCode": "SKU1", "quantity": 1 }],
  "customerPincode": "110001",
  "warehousePincode": "560001",
  "package": { "weightKg": 0.5, "lengthCm": 10, "widthCm": 10, "heightCm": 5 }
}
```

### `POST /api/dropshipper/orders`

Creates order, reserves stock, starts Razorpay. **COD rejected.**

```json
{
  "items": [{ "productCode": "SKU1", "quantity": 1 }],
  "warehousePincode": "560001",
  "dropshipRef": "IG-POST-42",
  "package": { "weightKg": 0.5, "lengthCm": 10, "widthCm": 10, "heightCm": 5 },
  "customer": {
    "fullName": "Rahul Kumar",
    "phone": "9876543210",
    "houseNumber": "12A",
    "area": "Connaught Place",
    "addressLine1": "Near Metro",
    "city": "New Delhi",
    "state": "Delhi",
    "postalCode": "110001"
  }
}
```

**Success (201)** includes `order` + `razorpay: { keyId, orderId, amount, currency }` for Checkout.js.  
If Razorpay env is missing / API fails: order is still created (`razorpayError: true`) — retry payment later.

### `POST /api/dropshipper/orders/verify-payment`

Same body as ecomm verify:

```json
{
  "orderId": "OWB-DS-123456",
  "razorpay_order_id": "order_…",
  "razorpay_payment_id": "pay_…",
  "razorpay_signature": "…"
}
```

Delegates to core payment verify (signature + amount + inventory commit). Existing Razorpay webhook also works for `OWB-DS-*` orders.

### List / detail (dropshipper)

| Method | Path |
|--------|------|
| GET | `/orders?page&limit&ref` |
| GET | `/orders/:orderId` |

### Admin dropship orders (filter hook)

**Base:** `/api/admin/dropshipper`  
**Auth:** `admin` | `order_manager` | `product_manager` | `inventory_manager`

| Method | Path | Query |
|--------|------|--------|
| GET | `/orders` | `page`, `limit`, `ref` / `dropshipRef`, `q`, `paymentStatus`, `orderStatus` |
| GET | `/orders/:orderId` | — |

---

## Safety guarantees

- Payable price = `dropshipBase` only (never ecomm/wholesale sale).  
- Payment method = online only.  
- Ecomm admin order match still excludes `storefront: dropship`.  
- Unpaid hold expiry does **not** merge dropship lines into ecomm/wholesale carts.  
- Inventory reserve uses shared warehouse (`ecomm` inventory channel).  

## Out of scope (later)

- Dropshipper register / login / subscription fee  

Ecomm `/api/delivery/*` and ecomm/wholesale catalogs / checkout are unchanged.
