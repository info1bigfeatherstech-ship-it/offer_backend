/**
 * Build a print view-model for custom Shipmozo 4×6 labels.
 * Shiprocket orders never call this module.
 */

const shippingProviderSettingsService = require('./shippingProviderSettings.service');
const { sanitizeSettings, defaultSettings } = require('./shipmozoLabelSettings.service');
const ShipmozoService = require('../utils/shipmozo');
const logger = require('../utils/logger');

const roundMoney2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function trimText(value, max) {
  const s = String(value || '').trim();
  if (!s) return '';
  const n = Math.max(1, Number(max) || 10);
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function formatInr(n) {
  const v = roundMoney2(n);
  if (!Number.isFinite(v)) return 'Rs.0';
  return `Rs.${v.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function formatYmd(d) {
  try {
    if (!d) return '';
    const dt = d instanceof Date ? d : new Date(d);
    if (Number.isNaN(dt.getTime())) return '';
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const day = String(dt.getDate()).padStart(2, '0');
    return `${y}/${m}/${day}`;
  } catch {
    return '';
  }
}

function customerName(addr) {
  return (
    String(addr?.fullName || addr?.name || '').trim() ||
    [addr?.firstName, addr?.lastName].filter(Boolean).join(' ').trim() ||
    'Customer'
  );
}

function customerPhone(addr) {
  const raw = String(addr?.phone || addr?.mobile || addr?.phoneNumber || '').replace(/\D/g, '');
  return raw.slice(-10);
}

function addressLines(addr) {
  const lines = [
    [addr?.houseNumber, addr?.building, addr?.floor].filter(Boolean).join(', '),
    addr?.addressLine1,
    addr?.addressLine2,
    addr?.area,
    addr?.landmark,
    [addr?.city, addr?.state, addr?.postalCode || addr?.pincode].filter(Boolean).join(', '),
    addr?.country || 'India'
  ]
    .map((x) => String(x || '').trim())
    .filter(Boolean);
  return lines;
}

function resolveSku(item) {
  try {
    const prod = item?.productId;
    if (prod && typeof prod === 'object' && Array.isArray(prod.variants) && item.variantId) {
      const v = prod.variants.find((x) => String(x._id) === String(item.variantId));
      if (v?.sku) return String(v.sku).trim();
    }
    const snapSku =
      item?.sku ||
      (Array.isArray(item?.variantAttributesSnapshot)
        ? item.variantAttributesSnapshot.find((a) => String(a?.key || '').toLowerCase() === 'sku')
            ?.value
        : null);
    return snapSku ? String(snapSku).trim() : '';
  } catch {
    return '';
  }
}

function resolveProductName(item) {
  try {
    if (item?.productId && typeof item.productId === 'object' && item.productId.name) {
      return String(item.productId.name).trim();
    }
    return String(item?.productName || 'Product').trim() || 'Product';
  } catch {
    return 'Product';
  }
}

function paymentAndCollectable(order) {
  const payMethod = String(order?.paymentInfo?.method || order?.paymentMethod || '')
    .toLowerCase()
    .trim();
  const balanceViaCod =
    String(order?.paymentInfo?.balanceCollectionMethod || '').toLowerCase() === 'cod';
  const totalInr = roundMoney2(Number(order?.totalAmount) || 0);
  const paidInr = roundMoney2(Number(order?.amountPaidInr) || 0);
  let balanceDue = roundMoney2(Math.max(0, Number(order?.balanceDueInr) || 0));
  if (!(balanceDue > 0.005) && paidInr > 0.005 && totalInr > 0.005) {
    balanceDue = roundMoney2(Math.max(0, totalInr - paidInr));
  }
  const unpaidInr = roundMoney2(Math.max(0, totalInr - paidInr));
  if (balanceDue > unpaidInr + 0.005) balanceDue = unpaidInr;
  const useCodAtDoor = payMethod === 'cod' || (balanceViaCod && balanceDue > 0.005);
  const collectable = useCodAtDoor ? (payMethod === 'cod' ? totalInr : balanceDue) : 0;
  return {
    paymentMode: useCodAtDoor ? 'COD' : 'PREPAID',
    collectable,
    orderTotal: totalInr,
    shippingCharges: roundMoney2(Number(order?.deliveryCharges) || 0)
  };
}

/** Assigned courier for the label header. Skip aggregator brand; keep original casing. */
function displayCourierName(order) {
  const candidates = [
    order?.shipmentInfo?.courier,
    order?.shippingSnapshot?.courierName
  ];
  for (const raw of candidates) {
    const name = String(raw || '').trim();
    if (!name) continue;
    if (/^ship\s*mozo$/i.test(name)) continue;
    return name;
  }
  return 'Courier';
}

function dimsAndWeight(order) {
  const dims = order?.shippingWeightSnapshot?.dims || {};
  const lengthCm = Math.max(0, Number(dims.lengthCm) || 0);
  const widthCm = Math.max(0, Number(dims.widthCm) || 0);
  const heightCm = Math.max(0, Number(dims.heightCm) || 0);
  const weightKg = Number(order?.shippingWeightSnapshot?.totalWeightKg);
  return {
    dimensionText:
      lengthCm && widthCm && heightCm
        ? `${lengthCm}x${widthCm}x${heightCm}`
        : '—',
    weightText:
      Number.isFinite(weightKg) && weightKg > 0 ? `${roundMoney2(weightKg)} kg` : '—'
  };
}

const warehouseCache = new Map();
const WAREHOUSE_CACHE_MS = 60 * 1000;

function warehouseApiName(wh) {
  if (!wh || typeof wh !== 'object') return '';
  return String(
    wh.name ||
      wh.warehouse_name ||
      wh.warehouseName ||
      wh.contact_name ||
      wh.contact_person ||
      wh.contactPerson ||
      ''
  ).trim();
}

async function resolvePickupWarehouse(storefront, sellerNameOverride) {
  const override = String(sellerNameOverride || '').trim();
  const envName = String(process.env.STORE_LEGAL_NAME || process.env.STORE_NAME || 'Seller').trim();
  try {
    const cfg = await shippingProviderSettingsService.getPublicConfig(storefront);
    const warehouseId = String(cfg?.shipmozo?.warehouseId || '').trim();
    const pickupPincode = String(cfg?.shipmozo?.pickupPincode || '').trim();
    const title = String(cfg?.shipmozo?.warehouseAddressTitle || '').trim();
    let wh = null;
    const cacheKey = `${storefront}:${warehouseId || 'none'}`;
    const cached = warehouseCache.get(cacheKey);
    let base = cached && Date.now() - cached.at < WAREHOUSE_CACHE_MS ? cached.value : null;
    if (!base) {
      if (warehouseId) {
        try {
          const list = await ShipmozoService.getWarehouses();
          const rows = Array.isArray(list?.warehouses) ? list.warehouses : [];
          wh =
            rows.find((w) => String(w.id || w.warehouse_id || '') === warehouseId) ||
            rows.find((w) => String(w.default || '').toUpperCase() === 'YES') ||
            null;
        } catch (err) {
          logger.warn('shipmozo label warehouse list failed', { message: err?.message });
        }
      }
      const shipmozoName = warehouseApiName(wh);
      let name = envName;
      let source = 'env';
      if (shipmozoName) {
        name = shipmozoName;
        source = 'shipmozo';
      } else if (title) {
        name = title;
        source = 'settings';
      }
      const phone = String(wh?.phone || process.env.STORE_PHONE || '').replace(/\D/g, '').slice(-10);
      const lines = [
        wh?.address_line_one || wh?.addressLineOne || wh?.address,
        wh?.address_line_two || wh?.addressLineTwo,
        [wh?.city, wh?.state, wh?.pincode || pickupPincode].filter(Boolean).join(', ')
      ]
        .map((x) => String(x || '').trim())
        .filter(Boolean);
      if (!lines.length && process.env.STORE_ADDRESS) {
        lines.push(String(process.env.STORE_ADDRESS).trim());
      }
      base = {
        name,
        phone,
        lines,
        pincode: wh?.pincode || pickupPincode || '',
        source
      };
      warehouseCache.set(cacheKey, { at: Date.now(), value: base });
    }
    if (base.source !== 'shipmozo' && override) {
      return { ...base, name: override, source: 'override' };
    }
    return base;
  } catch (err) {
    logger.warn('resolvePickupWarehouse failed', { message: err?.message });
    return {
      name: override || envName,
      phone: String(process.env.STORE_PHONE || '').replace(/\D/g, '').slice(-10),
      lines: [String(process.env.STORE_ADDRESS || '').trim()].filter(Boolean),
      pincode: String(process.env.STORE_PINCODE || '').trim(),
      source: override ? 'override' : 'env'
    };
  }
}

function buildLineItems(order, productsCfg) {
  const max = productsCfg.showAllItems
    ? 40
    : Math.max(1, Number(productsCfg.maxLineItems) || 10);
  const items = Array.isArray(order?.items) ? order.items : [];
  const nameMax = Number(productsCfg.trimProductNameUpto) || 10;
  const skuMax = Number(productsCfg.trimSkuUpto) || 10;
  const lines = [];
  let totalQty = 0;
  for (const item of items) {
    const qty = Math.max(0, Number(item.quantity) || 0);
    totalQty += qty;
    if (lines.length >= max) continue;
    const unit = roundMoney2(
      qty > 0
        ? (Number(item.priceSnapshot?.total) || 0) / qty
        : Number(item.priceSnapshot?.sale || item.priceSnapshot?.base) || 0
    );
    const total = roundMoney2(Number(item.priceSnapshot?.total) || unit * qty);
    lines.push({
      name: trimText(resolveProductName(item), nameMax),
      sku: trimText(resolveSku(item), skuMax),
      qty,
      price: unit,
      total,
      hsn: String(item.hsnCode || '').trim(),
      discount: roundMoney2(Number(item.priceSnapshot?.discount) || 0)
    });
  }
  return { lines, totalQty, hiddenCount: Math.max(0, items.length - lines.length) };
}

/**
 * @param {object} order
 * @param {object} [settingsPatch]
 */
async function buildLabelViewModel(order, settingsPatch) {
  const settings = sanitizeSettings(settingsPatch || defaultSettings());
  const storefront = String(order?.storefront || '').toLowerCase() === 'wholesale' ? 'wholesale' : 'ecomm';
  const addr = order?.addressSnapshot || {};
  const pay = paymentAndCollectable(order);
  const pack = dimsAndWeight(order);
  const pickup = await resolvePickupWarehouse(storefront, settings.pickup?.sellerName);
  const { lines, totalQty, hiddenCount } = buildLineItems(order, settings.products);
  const awb = String(order?.shipmentInfo?.awbCode || order?.shipmentInfo?.trackingNumber || '').trim();
  const courier = displayCourierName(order);
  const routingCode = String(
    order?.shipmentInfo?.routingCode || order?.shipmentInfo?.sortCode || ''
  ).trim();
  const rtoRoutingCode = String(order?.shipmentInfo?.rtoRoutingCode || '').trim();
  const eway = String(
    order?.shipmentInfo?.ewayBillNumber ||
      order?.paymentInfo?.ewayBillNumber ||
      order?.gstEwayBill ||
      ''
  ).trim();
  const created = order?.createdAt || new Date();
  const orderId = String(order?.orderId || '').trim();
  const shipmozoId = String(
    order?.shipmentInfo?.shipmozoOrderId ||
      order?.shipmentInfo?.shipmozoReferenceId ||
      order?.shipmentInfo?.shipmentId ||
      ''
  ).trim();

  return {
    settings,
    storefront,
    labelSize: '4x6',
    courier,
    awb,
    shipmozoId,
    orderId,
    shipToName: customerName(addr),
    shipToLines: addressLines(addr),
    shipToPhone: customerPhone(addr),
    paymentMode: pay.paymentMode,
    collectable: pay.collectable,
    orderTotal: pay.orderTotal,
    shippingCharges: pay.shippingCharges,
    dimensionText: pack.dimensionText,
    weightText: pack.weightText,
    routingCode,
    rtoRoutingCode,
    pickup,
    rto: pickup,
    supportEmail: settings.support.email,
    supportMobile: settings.support.mobile,
    invoiceNo: orderId ? `Retail${String(orderId).replace(/\W/g, '').slice(-8)}` : '',
    invoiceDate: formatYmd(created),
    orderDate: formatYmd(created),
    ewayBill: eway,
    lines,
    totalQty,
    hiddenCount,
    gstin: settings.pickup.gstin || String(process.env.STORE_GSTIN || '').trim(),
    poweredBy: 'Offer Wale Baba'
  };
}

const SAMPLE_ITEMS = [
  { name: 'SP 312 Wireless Bluetooth Speaker', sku: 'SKU-2734-1', qty: 1, price: 1900, total: 1900, hsn: '85182200', discount: 0 },
  { name: 'Portable Mini Hair Dryer 1800W', sku: 'SKU-2823-1', qty: 1, price: 1200, total: 1200, hsn: '85163200', discount: 0 },
  { name: 'Migraine Relief Head Massager', sku: 'SKU-2682-1', qty: 2, price: 850, total: 1700, hsn: '90191090', discount: 0 },
  { name: '3 in 1 Multi Charging Cable', sku: 'SKU-2659-1', qty: 1, price: 450, total: 450, hsn: '85444900', discount: 0 },
  { name: 'Travel Neck Pillow Memory Foam', sku: 'SKU-0643-1', qty: 1, price: 650, total: 650, hsn: '94049090', discount: 0 },
  { name: '2-in-1 Bedside Lamp with Wireless Charger', sku: 'SKU-0057-1', qty: 1, price: 2100, total: 2100, hsn: '94054090', discount: 0 },
  { name: 'Neev Electra Smart Watch Band', sku: 'SKU-0004-1', qty: 1, price: 990, total: 990, hsn: '91021200', discount: 0 },
  { name: 'Premium Stainless Steel Water Bottle 1L', sku: 'SKU-1188-1', qty: 2, price: 399, total: 798, hsn: '73239390', discount: 0 },
  { name: 'Organic Bamboo Toothbrush Set of 4', sku: 'SKU-3021-1', qty: 1, price: 299, total: 299, hsn: '96032100', discount: 0 },
  { name: 'LED Desk Lamp Adjustable Brightness', sku: 'SKU-4455-1', qty: 1, price: 1550, total: 1550, hsn: '94054020', discount: 0 }
];

function buildSampleLineItems(settings) {
  const p = settings.products || {};
  const nameMax = Number(p.trimProductNameUpto) || 999;
  const skuMax = Number(p.trimSkuUpto) || 999;
  const maxItems = p.showAllItems
    ? SAMPLE_ITEMS.length
    : Math.max(1, Number(p.maxLineItems) || 5);
  const visible = SAMPLE_ITEMS.slice(0, maxItems);
  const hiddenCount = Math.max(0, SAMPLE_ITEMS.length - visible.length);
  const lines = visible.map((item) => ({
    ...item,
    name: trimText(item.name, nameMax),
    sku: trimText(item.sku, skuMax)
  }));
  return {
    lines,
    totalQty: visible.reduce((sum, l) => sum + l.qty, 0),
    hiddenCount
  };
}

function buildSampleViewModel(settingsPatch, storefront) {
  const settings = sanitizeSettings(settingsPatch || defaultSettings());
  const sf = String(storefront || '').toLowerCase() === 'wholesale' ? 'wholesale' : 'ecomm';
  return {
    settings,
    storefront: sf,
    labelSize: '4x6',
    courier: 'XpressBees 10Kg',
    awb: 'SM1234567890',
    shipmozoId: '86543821',
    orderId: sf === 'wholesale' ? 'OWB-WH-865438' : 'OWB-ECOMM-865438',
    shipToName: 'John Wick',
    shipToLines: ['221B Baker Street', 'Connaught Place', 'New Delhi, Delhi, 110001', 'India'],
    shipToPhone: '9999999999',
    paymentMode: 'COD',
    collectable: 2000.6,
    orderTotal: 1000,
    shippingCharges: 0,
    dimensionText: '10x10x10',
    weightText: '1.5 kg',
    routingCode: 'DEL/UKH',
    rtoRoutingCode: 'DEL/UEY',
    pickup: {
      name: 'Manish Hasmukh Mehta',
      phone: '9001234567',
      lines: ['Sunshine Plaza, Sector 12', 'Near Main Road', 'Gurgaon, Haryana, 122018'],
      pincode: '122018'
    },
    rto: {
      name: 'Manish Hasmukh Mehta',
      phone: '9001234567',
      lines: ['Sunshine Plaza, Sector 12', 'Gurgaon, Haryana, 122018'],
      pincode: '122018'
    },
    supportEmail: settings.support.email,
    supportMobile: settings.support.mobile,
    invoiceNo: 'Retail16366',
    invoiceDate: '2025/01/03',
    orderDate: '2025/01/01',
    ewayBill: '1234567890',
    ...buildSampleLineItems(settings),
    gstin: settings.pickup.gstin,
    poweredBy: 'Offer Wale Baba'
  };
}

module.exports = {
  buildLabelViewModel,
  buildSampleViewModel,
  resolvePickupWarehouse,
  formatInr,
  trimText
};
