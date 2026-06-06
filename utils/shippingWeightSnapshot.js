/**
 * Checkout-time package weight snapshot for orders (Shiprocket quote + fulfilment audit).
 * Keeps per-line and total kg aligned with checkoutComputation / aggregateShipping rules.
 */

const mongoose = require('mongoose');
const Product = require('../models/Product');
const { roundMoney2 } = require('../services/checkoutComputation.service');

const DIM_WEIGHT_DIVISOR = 5000;

function unitWeightKgFromProductShipping(shipping) {
  return Math.max(0.05, roundMoney2(Number(shipping?.weight) || 0.5));
}

function unitDimsCmFromProductShipping(shipping) {
  const d = shipping?.dimensions || {};
  const l = Number(d.length);
  const w = Number(d.width);
  const h = Number(d.height);
  if (![l, w, h].every((n) => Number.isFinite(n) && n > 0)) return null;
  return {
    lengthCm: Math.max(1, l),
    widthCm: Math.max(1, w),
    heightCm: Math.max(1, h)
  };
}

function dimWeightKgFromDimsCm(dims) {
  if (!dims || typeof dims !== 'object') return null;
  const l = Number(dims.lengthCm);
  const w = Number(dims.widthCm);
  const h = Number(dims.heightCm);
  if (![l, w, h].every((n) => Number.isFinite(n) && n > 0)) return null;
  return roundMoney2((l * w * h) / DIM_WEIGHT_DIVISOR);
}

function buildLineDimFields(shipping, qty) {
  const dims = unitDimsCmFromProductShipping(shipping);
  if (!dims) return {};
  const unitDimWeightKg = dimWeightKgFromDimsCm(dims);
  const q = Math.max(0, Number(qty) || 0);
  return {
    lengthCm: dims.lengthCm,
    widthCm: dims.widthCm,
    heightCm: dims.heightCm,
    unitDimWeightKg,
    lineDimWeightKg: unitDimWeightKg != null ? roundMoney2(unitDimWeightKg * q) : null
  };
}

function hasLineDims(row) {
  return [row?.lengthCm, row?.widthCm, row?.heightCm].every(
    (n) => Number.isFinite(Number(n)) && Number(n) > 0
  );
}

/**
 * @param {{ lines: Array<{ product: object, variant: object, quantity: number }>, totalWeightKg?: number, dims?: object }} input
 */
function buildShippingWeightSnapshotFromCheckoutLines({ lines, totalWeightKg, dims }) {
  const lineSnapshots = (lines || []).map((line) => {
    const qty = Math.max(0, Number(line.quantity) || 0);
    const unitWeightKg = unitWeightKgFromProductShipping(line.product?.shipping);
    const variant = line.variant;
    const sku = variant?.sku ? String(variant.sku).trim() : null;
    return {
      productId: line.product?._id || null,
      variantId: variant?._id || null,
      productName: String(line.product?.name || 'Product').trim() || 'Product',
      sku: sku || null,
      quantity: qty,
      unitWeightKg,
      lineWeightKg: roundMoney2(unitWeightKg * qty),
      ...buildLineDimFields(line.product?.shipping, qty)
    };
  });

  const sumLines = roundMoney2(lineSnapshots.reduce((s, l) => s + Number(l.lineWeightKg || 0), 0));
  const total = Math.max(0.05, roundMoney2(Number(totalWeightKg) || sumLines));
  const packageDims = {
    lengthCm: dims?.lengthCm != null ? Number(dims.lengthCm) : null,
    widthCm: dims?.widthCm != null ? Number(dims.widthCm) : null,
    heightCm: dims?.heightCm != null ? Number(dims.heightCm) : null
  };

  return {
    totalWeightKg: total,
    totalDimWeightKg: dimWeightKgFromDimsCm(packageDims),
    dims: packageDims,
    lines: lineSnapshots,
    source: 'checkout'
  };
}

/**
 * Legacy orders: derive weights from current catalog (display-only fallback).
 * @param {import('mongoose').Document|object} order
 */
async function buildShippingWeightSnapshotFromOrderItems(order) {
  const items = Array.isArray(order?.items) ? order.items : [];
  if (!items.length) return null;

  const lineSnapshots = [];
  for (const item of items) {
    let unitWeightKg = 0.5;
    let productName = 'Product';
    let sku = null;
    let productShipping = null;

    if (item.productId) {
      const pid = mongoose.Types.ObjectId.isValid(item.productId) ? item.productId : item.productId?._id;
      let product = item.productId;
      if (pid && (!product.shipping || typeof product.shipping !== 'object')) {
        product = await Product.findById(pid).select('name shipping variants').lean();
      }
      if (product) {
        productName = product.name || productName;
        productShipping = product.shipping;
        unitWeightKg = unitWeightKgFromProductShipping(product.shipping);
        const v = (product.variants || []).find((x) => String(x._id) === String(item.variantId));
        if (v?.sku) sku = String(v.sku).trim();
      }
    }

    const qty = Math.max(0, Number(item.quantity) || 0);
    lineSnapshots.push({
      productId: item.productId?._id || item.productId || null,
      variantId: item.variantId || null,
      productName,
      sku,
      quantity: qty,
      unitWeightKg,
      lineWeightKg: roundMoney2(unitWeightKg * qty),
      ...buildLineDimFields(productShipping, qty)
    });
  }

  const totalWeightKg = Math.max(
    0.05,
    roundMoney2(lineSnapshots.reduce((s, l) => s + Number(l.lineWeightKg || 0), 0))
  );

  return {
    totalWeightKg,
    totalDimWeightKg: null,
    dims: { lengthCm: null, widthCm: null, heightCm: null },
    lines: lineSnapshots,
    source: 'catalog_fallback'
  };
}

/**
 * Fill missing per-line dims on stored snapshots (legacy orders) from current catalog.
 * @param {object|null} snap
 */
async function enrichShippingWeightSnapshotDims(snap) {
  if (!snap?.lines?.length) return snap;

  const lines = [...snap.lines];
  const missingProductIds = [
    ...new Set(
      lines
        .filter((row) => !hasLineDims(row) && row?.productId)
        .map((row) => String(row.productId))
    )
  ];

  const productById = new Map();
  if (missingProductIds.length) {
    const ids = missingProductIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
    const products = await Product.find({ _id: { $in: ids } }).select('shipping').lean();
    for (const p of products) {
      productById.set(String(p._id), p);
    }
  }

  let changed = false;
  const enrichedLines = lines.map((row) => {
    if (hasLineDims(row)) return row;
    const product = productById.get(String(row.productId));
    if (!product?.shipping) return row;
    const dimFields = buildLineDimFields(product.shipping, row.quantity);
    if (!Object.keys(dimFields).length) return row;
    changed = true;
    return { ...row, ...dimFields };
  });

  const packageDims = snap.dims || {};
  const totalDimWeightKg =
    snap.totalDimWeightKg != null
      ? snap.totalDimWeightKg
      : dimWeightKgFromDimsCm(packageDims);

  if (!changed && snap.totalDimWeightKg != null) return snap;

  return {
    ...snap,
    totalDimWeightKg,
    lines: enrichedLines
  };
}

/**
 * Package metrics for Shiprocket create/assign — prefer frozen checkout snapshot.
 * @param {object} order
 * @returns {Promise<{ totalWeight: number, maxL: number, maxB: number, maxH: number, lineWeightByVariantId: Map<string, number> }>}
 */
async function resolveShiprocketPackageMetrics(order) {
  const snap = order?.shippingWeightSnapshot;
  const lineWeightByVariantId = new Map();

  if (snap?.lines?.length) {
    for (const row of snap.lines) {
      if (row?.variantId != null) {
        lineWeightByVariantId.set(String(row.variantId), Number(row.unitWeightKg) || 0.5);
      }
    }
    const maxL = Math.max(10, Number(snap.dims?.lengthCm) || 10);
    const maxB = Math.max(10, Number(snap.dims?.widthCm) || 10);
    const maxH = Math.max(10, Number(snap.dims?.heightCm) || 10);
    return {
      totalWeight: Math.max(0.05, Number(snap.totalWeightKg) || 0.5),
      maxL,
      maxB,
      maxH,
      lineWeightByVariantId
    };
  }

  return null;
}

module.exports = {
  buildShippingWeightSnapshotFromCheckoutLines,
  buildShippingWeightSnapshotFromOrderItems,
  enrichShippingWeightSnapshotDims,
  resolveShiprocketPackageMetrics,
  unitWeightKgFromProductShipping,
  dimWeightKgFromDimsCm
};
