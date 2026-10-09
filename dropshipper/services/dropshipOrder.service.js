'use strict';

/**
 * Isolated dropship order create + Razorpay initiation.
 * Does not use ecomm/wholesale cart or CheckoutQuote.
 * Online (prepaid) only — COD is rejected.
 */

const mongoose = require('mongoose');
const Razorpay = require('razorpay');
const Product = require('../../models/Product');
const Order = require('../../models/Order');
const Address = require('../../models/Address');
const {
  roundMoney2,
  calculateTax,
  aggregateShipping
} = require('../../services/checkoutComputation.service');
const { overlayExternalStockOnProducts } = require('../../services/inventoryStockOverlay.service');
const {
  reserveCheckoutStock,
  releaseOrderStockHold
} = require('../../services/orderStockBridge.service');
const { allocateUniqueOrderId, orderIdsForDigitSuffix } = require('../../utils/orderId');
const { buildShippingWeightSnapshotFromCheckoutLines } = require('../../utils/shippingWeightSnapshot');
const { resolveVariantShipping } = require('../../utils/variantCatalogFields');
const { validatePhysicalAddressForSave } = require('../../utils/addressValidation');
const paymentHoldExpiryService = require('../../services/paymentHoldExpiry.service');
const shippingProviderSettingsService = require('../../services/shippingProviderSettings.service');
const { SHIPPING_PROVIDERS } = require('../../constants/shippingProviders');
const logger = require('../../utils/logger');
const {
  isVariantDropshipListed,
  normalizeProductCode
} = require('../utils/dropshipCatalog');
const { checkServiceability } = require('./serviceability.service');

const DROPSHIP_STOREFRONT = 'dropship';
const MAX_LINES = 30;
const MAX_QTY_PER_LINE = 99;
const MAX_REF_LEN = 64;

function createError(statusCode, code, message, details = null) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  if (details) err.details = details;
  return err;
}

function getRazorpayClient() {
  const key_id = String(process.env.RAZORPAY_KEY_ID || '').trim();
  const key_secret = String(process.env.RAZORPAY_KEY_SECRET || '').trim();
  if (!key_id || !key_secret) {
    return { client: null, missingEnv: true };
  }
  return {
    client: new Razorpay({ key_id, key_secret }),
    missingEnv: false
  };
}

function normalizeItems(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw createError(400, 'VALIDATION_ERROR', 'items must be a non-empty array');
  }
  if (rawItems.length > MAX_LINES) {
    throw createError(400, 'VALIDATION_ERROR', `Maximum ${MAX_LINES} line items allowed`);
  }

  const merged = new Map();
  for (const row of rawItems) {
    const productCode = normalizeProductCode(row?.productCode || row?.sku || row?.code);
    if (!productCode) {
      throw createError(400, 'VALIDATION_ERROR', 'Each item requires productCode');
    }
    const qty = Number(row?.quantity ?? row?.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY_PER_LINE) {
      throw createError(
        400,
        'VALIDATION_ERROR',
        `quantity for ${productCode} must be an integer 1–${MAX_QTY_PER_LINE}`
      );
    }
    merged.set(productCode, (merged.get(productCode) || 0) + qty);
  }

  return [...merged.entries()].map(([productCode, quantity]) => ({ productCode, quantity }));
}

function normalizeDropshipRef(value) {
  if (value == null || value === '') return null;
  const ref = String(value).trim().slice(0, MAX_REF_LEN);
  return ref || null;
}

function parseOptionalPackageOverride(pkg) {
  if (!pkg || typeof pkg !== 'object') return null;
  const weightKg = Number(pkg.weightKg ?? pkg.weight);
  const lengthCm = Number(pkg.lengthCm ?? pkg.length ?? pkg.l);
  const widthCm = Number(pkg.widthCm ?? pkg.breadthCm ?? pkg.breadth ?? pkg.width ?? pkg.b);
  const heightCm = Number(pkg.heightCm ?? pkg.height ?? pkg.h);
  if (
    ![weightKg, lengthCm, widthCm, heightCm].every((n) => Number.isFinite(n) && n > 0)
  ) {
    throw createError(
      400,
      'VALIDATION_ERROR',
      'package requires positive weightKg, lengthCm, widthCm, heightCm'
    );
  }
  return {
    weightKg: Math.max(0.05, weightKg),
    lengthCm,
    widthCm,
    heightCm
  };
}

/**
 * Resolve dropship-listed variants by productCode and price with dropshipBase only.
 */
async function resolveDropshipLines(items) {
  const codes = items.map((i) => i.productCode);
  const products = await Product.find({
    'variants.productCode': { $in: codes }
  }).exec();

  await overlayExternalStockOnProducts(products, {
    storefront: 'ecomm',
    logContext: 'dropshipOrder.resolve'
  });

  const byCode = new Map();
  for (const product of products) {
    for (const variant of product.variants || []) {
      const code = normalizeProductCode(variant.productCode);
      if (code) byCode.set(code, { product, variant });
    }
  }

  const lines = [];
  const orderItems = [];
  let subtotal = 0;

  for (const item of items) {
    const hit = byCode.get(item.productCode);
    if (!hit) {
      throw createError(404, 'VARIANT_NOT_FOUND', `Variant ${item.productCode} not found`);
    }
    const { product, variant } = hit;
    if (!isVariantDropshipListed(variant)) {
      throw createError(
        400,
        'DROPSHIP_NOT_LISTED',
        `${item.productCode} is not available for dropship`
      );
    }
    const dropshipPrice = Number(variant.price?.dropshipBase);
    if (!Number.isFinite(dropshipPrice) || dropshipPrice <= 0) {
      throw createError(
        400,
        'DROPSHIP_PRICE_MISSING',
        `${item.productCode} has no valid dropship price`
      );
    }
    if (variant.inventory?.trackInventory !== false) {
      const qty = Number(variant.inventory?.quantity) || 0;
      if (qty < item.quantity) {
        throw createError(
          409,
          'INSUFFICIENT_STOCK',
          `${product.name || item.productCode} has only ${qty} in stock`,
          { productCode: item.productCode, available: qty, requested: item.quantity }
        );
      }
    }

    const itemTotal = roundMoney2(dropshipPrice * item.quantity);
    subtotal = roundMoney2(subtotal + itemTotal);
    const resolvedShipping = resolveVariantShipping(variant, product);

    lines.push({
      product,
      variant,
      quantity: item.quantity,
      itemTotal,
      resolvedShipping,
      unitPrice: dropshipPrice
    });

    orderItems.push({
      productId: product._id,
      variantId: variant._id,
      productCode: item.productCode,
      quantity: item.quantity,
      priceSnapshot: {
        base: dropshipPrice,
        sale: dropshipPrice,
        total: itemTotal
      },
      variantAttributesSnapshot: Array.isArray(variant.attributes)
        ? variant.attributes.map((a) => ({
            key: a?.key != null ? String(a.key) : '',
            value: a?.value != null ? String(a.value) : ''
          }))
        : [],
      userType: 'normal',
      hsnCode: product.hsnCode || null,
      gstRate: product.gstRate != null ? product.gstRate : null,
      isFragile: Boolean(product.isFragile)
    });
  }

  const dims = aggregateShipping(lines);
  const tax = calculateTax(lines);

  return {
    lines,
    orderItems,
    subtotal,
    tax,
    dims,
    totalWeight: dims.weightKg
  };
}

async function quoteDropshipOrder(input = {}) {
  const items = normalizeItems(input.items);
  const evaluated = await resolveDropshipLines(items);

  const customerPincode = String(
    input.customerPincode ||
      input.deliveryPincode ||
      input.pincode ||
      input.customer?.postalCode ||
      ''
  ).replace(/\D/g, '');

  let shipping = null;
  if (/^\d{6}$/.test(customerPincode) && input.warehousePincode) {
    const pkg = parseOptionalPackageOverride(input.package) || {
      weightKg: evaluated.dims.weightKg,
      lengthCm: evaluated.dims.lengthCm,
      widthCm: evaluated.dims.widthCm,
      heightCm: evaluated.dims.heightCm
    };
    const svc = await checkServiceability({
      customerPincode,
      warehousePincode: input.warehousePincode,
      ...pkg,
      paymentMode: 'prepaid',
      orderAmount: evaluated.subtotal,
      storefront: 'ecomm'
    });
    shipping = svc.quotes?.prepaid || null;
    if (!shipping?.isDeliverable) {
      throw createError(
        400,
        'NOT_SERVICEABLE',
        shipping?.message || 'Delivery not available for this pincode',
        { serviceability: svc }
      );
    }
  }

  const deliveryCharges = shipping ? roundMoney2(shipping.deliveryCharges || 0) : null;
  const amountPayable =
    deliveryCharges != null
      ? roundMoney2(evaluated.subtotal + deliveryCharges + evaluated.tax)
      : null;

  return {
    storefront: DROPSHIP_STOREFRONT,
    paymentMethod: 'online',
    items: evaluated.lines.map((l) => ({
      productCode: normalizeProductCode(l.variant.productCode),
      productName: l.product.name || l.product.title || null,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      lineTotal: l.itemTotal
    })),
    package: parseOptionalPackageOverride(input.package) || {
      weightKg: evaluated.dims.weightKg,
      lengthCm: evaluated.dims.lengthCm,
      widthCm: evaluated.dims.widthCm,
      heightCm: evaluated.dims.heightCm
    },
    subtotal: evaluated.subtotal,
    tax: evaluated.tax,
    discount: 0,
    deliveryCharges,
    amountPayable,
    shipping,
    currency: 'INR'
  };
}

async function createDropshipOrder({ userId, body }) {
  if (!userId || !mongoose.Types.ObjectId.isValid(String(userId))) {
    throw createError(401, 'UNAUTHORIZED', 'Authenticated user required to place dropship order');
  }

  const paymentMethod = String(body?.paymentMethod || 'online').toLowerCase().trim();
  if (paymentMethod !== 'online') {
    throw createError(400, 'COD_NOT_ALLOWED', 'Dropship orders support online payment only');
  }

  const items = normalizeItems(body?.items);
  const dropshipRef = normalizeDropshipRef(body?.dropshipRef || body?.ref || body?.tag);
  const warehousePincode = body?.warehousePincode || body?.pickupPincode;
  if (!warehousePincode) {
    throw createError(400, 'VALIDATION_ERROR', 'warehousePincode is required');
  }

  const addressCheck = validatePhysicalAddressForSave(body?.customer || body?.address || {});
  if (!addressCheck.ok) {
    throw createError(400, addressCheck.code || 'ADDRESS_VALIDATION_FAILED', addressCheck.message, {
      errors: addressCheck.errors
    });
  }

  const evaluated = await resolveDropshipLines(items);
  const pkg =
    parseOptionalPackageOverride(body?.package) || {
      weightKg: evaluated.dims.weightKg,
      lengthCm: evaluated.dims.lengthCm,
      widthCm: evaluated.dims.widthCm,
      heightCm: evaluated.dims.heightCm
    };

  const svc = await checkServiceability({
    customerPincode: addressCheck.data.postalCode,
    warehousePincode,
    ...pkg,
    paymentMode: 'prepaid',
    orderAmount: evaluated.subtotal,
    storefront: 'ecomm'
  });
  const prepaid = svc.quotes?.prepaid;
  if (!prepaid?.isDeliverable) {
    throw createError(
      400,
      'NOT_SERVICEABLE',
      prepaid?.message || 'Delivery not available for this pincode',
      { serviceability: svc }
    );
  }

  const deliveryCharges = roundMoney2(prepaid.deliveryCharges || 0);
  const tax = evaluated.tax;
  const subtotal = evaluated.subtotal;
  const discount = 0;
  const totalAmount = roundMoney2(subtotal + deliveryCharges + tax - discount);
  if (!(totalAmount > 0)) {
    throw createError(400, 'INVALID_TOTAL', 'Order total must be greater than zero');
  }

  let orderShippingProvider = prepaid.shippingProvider || null;
  if (orderShippingProvider !== 'shipmozo' && orderShippingProvider !== 'shiprocket') {
    try {
      orderShippingProvider = await shippingProviderSettingsService.getActiveProviderForNewOrders(
        'ecomm'
      );
    } catch (_) {
      orderShippingProvider = SHIPPING_PROVIDERS.SHIPROCKET;
    }
  }

  const shippingWeightSnapshot = buildShippingWeightSnapshotFromCheckoutLines({
    lines: evaluated.lines,
    totalWeightKg: pkg.weightKg,
    dims: {
      lengthCm: pkg.lengthCm,
      widthCm: pkg.widthCm,
      heightCm: pkg.heightCm
    }
  });

  const session = await mongoose.startSession();
  session.startTransaction();

  let candidateOrderId = null;
  let order = null;
  let inventoryHold = null;

  try {
    const addressDoc = new Address({
      userId,
      storefront: 'ecomm',
      ...addressCheck.data,
      addressType: 'other',
      isGift: false,
      deliveryInstructions: String(
        body?.customer?.deliveryInstructions || body?.deliveryInstructions || ''
      ).trim(),
      isDefault: false
    });
    await addressDoc.save({ session });

    candidateOrderId = await allocateUniqueOrderId({
      storefront: DROPSHIP_STOREFRONT,
      userType: 'normal',
      maxAttempts: 32,
      isSuffixTaken: async (digits) => {
        const ids = orderIdsForDigitSuffix(digits);
        return Boolean(await Order.exists({ orderId: { $in: ids } }).session(session));
      }
    });

    inventoryHold = await reserveCheckoutStock({
      orderId: candidateOrderId,
      storefront: 'ecomm', // inventory API only knows ecomm|wholesale; DS uses shared warehouse
      lines: evaluated.lines.map((l) => ({
        product: l.product,
        variant: l.variant,
        quantity: l.quantity
      })),
      session
    });

    const razorpayChargePaise = Math.round(totalAmount * 100);

    order = new Order({
      orderId: candidateOrderId,
      userId,
      items: evaluated.orderItems,
      subtotal,
      deliveryCharges,
      deliveryFreightInr:
        prepaid.freightInr != null ? roundMoney2(Number(prepaid.freightInr)) : deliveryCharges,
      deliveryCodFeeInr: 0,
      tax,
      discount,
      totalAmount,
      address: addressDoc._id,
      addressSnapshot: addressDoc.toObject(),
      userType: 'normal',
      storefront: DROPSHIP_STOREFRONT,
      dropshipMeta: {
        ref: dropshipRef,
        placedByUserId: userId,
        customerPhone: addressCheck.data.phone,
        customerName: addressCheck.data.fullName
      },
      shippingProvider: orderShippingProvider,
      inventoryHold,
      orderStatus: 'pending',
      paymentStatus: 'pending',
      amountPaidInr: 0,
      balanceDueInr: totalAmount,
      appliedCoupon: { code: null, discount: 0 },
      paymentInfo: {
        method: 'online',
        status: 'initiated',
        amountPaise: razorpayChargePaise,
        splitMode: 'full',
        advancePercent: null,
        balanceCollectionMethod: 'online',
        fullOrderAmountPaise: razorpayChargePaise,
        channel: 'dropship',
        sessions: []
      },
      shippingSnapshot: {
        courierName: prepaid.courierName || null,
        estimatedDays: prepaid.estimatedDays || null,
        courierCompanyId:
          prepaid.courierCompanyId != null && Number.isFinite(Number(prepaid.courierCompanyId))
            ? Number(prepaid.courierCompanyId)
            : null,
        shipmozoCourierId:
          orderShippingProvider === 'shipmozo' &&
          prepaid.courierCompanyId != null &&
          Number.isFinite(Number(prepaid.courierCompanyId))
            ? Number(prepaid.courierCompanyId)
            : null,
        provider: orderShippingProvider,
        pickupsAutomaticallyScheduled: null
      },
      shippingWeightSnapshot,
      paymentHoldExpiresAt: new Date(Date.now() + paymentHoldExpiryService.getPaymentHoldMs())
    });

    await order.save({ session });
    await session.commitTransaction();
    session.endSession();
  } catch (err) {
    await session.abortTransaction().catch(() => {});
    session.endSession();
    if (candidateOrderId && inventoryHold?.inventoryReserved) {
      try {
        const stub = { orderId: candidateOrderId, inventoryHold, storefront: 'ecomm', items: [] };
        await releaseOrderStockHold(stub);
      } catch (releaseErr) {
        logger.warn('[dropshipOrder] release after failed create', {
          orderId: candidateOrderId,
          message: releaseErr?.message
        });
      }
    }
    if (err?.code === 11000) {
      throw createError(503, 'ORDER_ID_GENERATION_FAILED', 'Could not allocate unique order ID');
    }
    throw err;
  }

  // Razorpay after commit (same pattern as ecomm checkout)
  const { client: razorpay, missingEnv } = getRazorpayClient();
  if (missingEnv) {
    logger.error('[dropshipOrder] Razorpay env missing');
    return {
      order,
      razorpayOrder: null,
      razorpayError: true,
      razorpayErrorDetail: {
        description: 'Server env: set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET',
        code: 'MISSING_RAZORPAY_ENV'
      }
    };
  }

  try {
    const razorpayOrder = await razorpay.orders.create({
      amount: Math.round(totalAmount * 100),
      currency: 'INR',
      receipt: order.orderId.slice(0, 40),
      payment_capture: 1,
      notes: {
        orderId: order.orderId,
        userId: String(userId),
        channel: 'dropship',
        dropshipRef: dropshipRef || ''
      }
    });

    order.paymentInfo.razorpayOrderId = razorpayOrder.id;
    order.paymentInfo.amountPaise = razorpayOrder.amount;
    order.paymentInfo.status = 'created';
    order.paymentInfo.sessions = [
      {
        razorpayOrderId: razorpayOrder.id,
        expectedAmountPaise: Number(razorpayOrder.amount),
        status: 'created'
      }
    ];
    order.markModified('paymentInfo');
    await order.save();

    return { order, razorpayOrder, razorpayError: false };
  } catch (razorpayError) {
    logger.error('[dropshipOrder] Razorpay create failed', {
      orderId: order.orderId,
      message: razorpayError?.message
    });
    const bodyErr = razorpayError && (razorpayError.error || razorpayError);
    return {
      order,
      razorpayOrder: null,
      razorpayError: true,
      razorpayErrorDetail: {
        description:
          (bodyErr && (bodyErr.description || bodyErr.message)) ||
          razorpayError?.message ||
          'Razorpay API rejected the request',
        code: bodyErr?.code || null,
        statusCode: razorpayError?.statusCode != null ? razorpayError.statusCode : null
      }
    };
  }
}

function serializeDropshipOrder(order) {
  if (!order) return null;
  const o = typeof order.toObject === 'function' ? order.toObject() : order;
  return {
    orderId: o.orderId,
    storefront: o.storefront,
    orderStatus: o.orderStatus,
    paymentStatus: o.paymentStatus,
    subtotal: o.subtotal,
    tax: o.tax,
    discount: o.discount,
    deliveryCharges: o.deliveryCharges,
    totalAmount: o.totalAmount,
    amountPaidInr: o.amountPaidInr,
    balanceDueInr: o.balanceDueInr,
    paymentHoldExpiresAt: o.paymentHoldExpiresAt,
    dropshipMeta: o.dropshipMeta || null,
    items: (o.items || []).map((it) => ({
      productCode: it.productCode,
      quantity: it.quantity,
      priceSnapshot: it.priceSnapshot
    })),
    shippingSnapshot: o.shippingSnapshot || null,
    addressSnapshot: o.addressSnapshot
      ? {
          fullName: o.addressSnapshot.fullName,
          phone: o.addressSnapshot.phone,
          city: o.addressSnapshot.city,
          state: o.addressSnapshot.state,
          postalCode: o.addressSnapshot.postalCode
        }
      : null,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt
  };
}

async function listDropshipOrdersForUser(userId, { page = 1, limit = 20, ref } = {}) {
  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(100, Math.max(1, Number(limit) || 20));
  const filter = {
    storefront: DROPSHIP_STOREFRONT,
    $or: [{ userId }, { 'dropshipMeta.placedByUserId': userId }]
  };
  const refNorm = normalizeDropshipRef(ref);
  if (refNorm) filter['dropshipMeta.ref'] = refNorm;

  const [rows, total] = await Promise.all([
    Order.find(filter)
      .sort({ createdAt: -1 })
      .skip((p - 1) * l)
      .limit(l)
      .lean(),
    Order.countDocuments(filter)
  ]);

  return {
    orders: rows.map(serializeDropshipOrder),
    page: p,
    limit: l,
    total,
    totalPages: Math.ceil(total / l) || 1
  };
}

async function getDropshipOrderForUser(userId, orderId) {
  const order = await Order.findOne({
    orderId: String(orderId || '').trim(),
    storefront: DROPSHIP_STOREFRONT,
    $or: [{ userId }, { 'dropshipMeta.placedByUserId': userId }]
  }).lean();
  return order;
}

async function listAdminDropshipOrders({ page = 1, limit = 20, ref, q, paymentStatus, orderStatus } = {}) {
  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(100, Math.max(1, Number(limit) || 20));
  const filter = { storefront: DROPSHIP_STOREFRONT };

  const refNorm = normalizeDropshipRef(ref);
  if (refNorm) filter['dropshipMeta.ref'] = refNorm;

  if (paymentStatus) filter.paymentStatus = String(paymentStatus).toLowerCase().trim();
  if (orderStatus) filter.orderStatus = String(orderStatus).toLowerCase().trim();

  const query = String(q || '').trim();
  if (query) {
    const safe = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      { orderId: { $regex: safe, $options: 'i' } },
      { 'dropshipMeta.ref': { $regex: safe, $options: 'i' } },
      { 'dropshipMeta.customerPhone': { $regex: safe, $options: 'i' } },
      { 'dropshipMeta.customerName': { $regex: safe, $options: 'i' } },
      { 'addressSnapshot.postalCode': { $regex: safe, $options: 'i' } }
    ];
  }

  const [rows, total] = await Promise.all([
    Order.find(filter)
      .sort({ createdAt: -1 })
      .skip((p - 1) * l)
      .limit(l)
      .lean(),
    Order.countDocuments(filter)
  ]);

  return {
    orders: rows.map(serializeDropshipOrder),
    page: p,
    limit: l,
    total,
    totalPages: Math.ceil(total / l) || 1
  };
}

async function getAdminDropshipOrder(orderId) {
  return Order.findOne({
    orderId: String(orderId || '').trim(),
    storefront: DROPSHIP_STOREFRONT
  }).lean();
}

module.exports = {
  DROPSHIP_STOREFRONT,
  quoteDropshipOrder,
  createDropshipOrder,
  serializeDropshipOrder,
  listDropshipOrdersForUser,
  getDropshipOrderForUser,
  listAdminDropshipOrders,
  getAdminDropshipOrder,
  getRazorpayClient
};
