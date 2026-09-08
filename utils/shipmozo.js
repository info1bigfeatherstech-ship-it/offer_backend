/**
 * Shipmozo External V1 API client.
 * Base: https://shipping-api.com/app/api/v1  (no trailing slash)
 * Auth: public-key + private-key request headers.
 *
 * Does not share STORE_PINCODE / PICKUP_PINCODE with Shiprocket —
 * uses ShippingProviderSettings / SHIPMOZO_* env for warehouse + pickup pin.
 */

const axios = require('axios');
const mongoose = require('mongoose');
const Product = require('../models/Product');
const logger = require('./logger');
const shippingProviderSettingsService = require('../services/shippingProviderSettings.service');
const { sanitizeCourierConsigneeName } = require('./addressValidation');

const DEFAULT_BASE = 'https://shipping-api.com/app/api/v1';
const roundMoney2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function kgToGrams(weightKg) {
  const kg = Math.max(0.05, Number(weightKg) || 0.5);
  return Math.max(50, Math.round(kg * 1000));
}

function parseShipmozoResult(data) {
  const result = data?.result != null ? String(data.result) : '';
  const ok = result === '1' || result === 'true' || data?.success === true;
  const message = extractShipmozoFailureMessage(data, ok);
  return {
    ok,
    message,
    data: data?.data ?? null,
    raw: data
  };
}

/**
 * Prefer a useful human message when Shipmozo returns opaque "Error".
 */
function extractShipmozoFailureMessage(data, ok) {
  if (ok) return data?.message || 'Success';

  const candidates = [
    data?.message,
    data?.error,
    data?.msg,
    data?.data?.message,
    data?.data?.error,
    data?.data?.msg,
    Array.isArray(data?.errors) ? data.errors.map((e) => (typeof e === 'string' ? e : e?.message)).filter(Boolean).join('; ') : null,
    data?.response?.message,
  ];

  for (const c of candidates) {
    const s = c != null ? String(c).trim() : '';
    if (!s) continue;
    if (/^error$/i.test(s)) continue;
    return s;
  }

  // Last resort: short JSON snippet (not huge dumps)
  try {
    if (data && typeof data === 'object') {
      const compact = JSON.stringify(data);
      if (compact && compact !== '{}' && compact.length <= 280) {
        return `Shipmozo rejected the request: ${compact}`;
      }
    }
  } catch (_) {
    /* ignore */
  }

  return data?.message ? String(data.message) : 'Shipmozo request failed';
}

/**
 * Shipmozo may return serviceable as boolean, "true"/"false", or 1/0.
 * Only treat explicit positives as serviceable.
 */
function isShipmozoServiceableFlag(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0 || value == null) return false;
  const s = String(value).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

function emptyShipmozoQuote(message, extra = {}) {
  return {
    isDeliverable: false,
    deliveryCharges: 0,
    freightInr: 0,
    codFeeInr: 0,
    estimatedDays: null,
    courierName: null,
    courierCompanyId: null,
    shipmozoCourierId: null,
    message,
    provider: 'shipmozo',
    mock: false,
    ...extra
  };
}

class ShipmozoService {
  constructor() {
    this.baseURL = String(process.env.SHIPMOZO_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '');
  }

  async getConfig(storefront) {
    return shippingProviderSettingsService.getRuntimeConfig(storefront);
  }

  async isConfigured(storefront) {
    const cfg = await this.getConfig(storefront);
    const sm = cfg.shipmozo || {};
    return Boolean(sm.enabled && sm.publicKey && sm.privateKey && sm.warehouseId && sm.pickupPincode);
  }

  async buildHeaders() {
    const cfg = await this.getConfig();
    const sm = cfg.shipmozo || {};
    if (!sm.publicKey || !sm.privateKey) {
      return null;
    }
    return {
      'public-key': sm.publicKey,
      'private-key': sm.privateKey,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    };
  }

  async request({ method, path, data, params, timeout = 25000 }) {
    const headers = await this.buildHeaders();
    if (!headers) {
      return {
        ok: false,
        message: 'Shipmozo API keys are not configured',
        code: 'SHIPMOZO_KEYS_MISSING',
        data: null,
        raw: null
      };
    }

    const url = `${this.baseURL}${path.startsWith('/') ? path : `/${path}`}`;
    try {
      const res = await axios({
        method,
        url,
        headers,
        data,
        params,
        timeout,
        validateStatus: () => true
      });

      const body = res.data;
      if (res.status >= 500) {
        logger.error('[Shipmozo] HTTP server error', { status: res.status, path, body });
        return {
          ok: false,
          message: `Shipmozo server error (${res.status})`,
          code: 'SHIPMOZO_HTTP_ERROR',
          data: null,
          raw: body,
          httpStatus: res.status
        };
      }

      const parsed = parseShipmozoResult(body);
      if (!parsed.ok) {
        logger.warn('[Shipmozo] API failure', {
          path,
          message: parsed.message,
          status: res.status
        });
      }
      return {
        ok: parsed.ok,
        message: parsed.message,
        data: parsed.data,
        raw: parsed.raw,
        httpStatus: res.status,
        code: parsed.ok ? null : 'SHIPMOZO_API_ERROR'
      };
    } catch (err) {
      logger.error('[Shipmozo] request failed', {
        path,
        message: err.message,
        code: err.code
      });
      return {
        ok: false,
        message: err.message || 'Shipmozo network error',
        code: 'SHIPMOZO_NETWORK_ERROR',
        data: null,
        raw: err.response?.data || null
      };
    }
  }

  async info() {
    return this.request({ method: 'get', path: '/info' });
  }

  /**
   * Pincode serviceability between Shipmozo warehouse pin and delivery pin.
   */
  async checkPincodeServiceability(deliveryPincode, storefront = 'ecomm') {
    const cfg = await this.getConfig(storefront);
    const pickup = String(cfg.shipmozo?.pickupPincode || '')
      .replace(/\D/g, '')
      .slice(0, 6);
    const delivery = String(deliveryPincode || '')
      .replace(/\D/g, '')
      .slice(0, 6);

    if (pickup.length !== 6) {
      return {
        ok: false,
        serviceable: false,
        explicitlyNotServiceable: false,
        message: 'Shipmozo pickup pincode is not configured',
        code: 'SHIPMOZO_PICKUP_PIN_MISSING'
      };
    }
    if (delivery.length !== 6) {
      return {
        ok: false,
        serviceable: false,
        explicitlyNotServiceable: false,
        message: 'Valid 6-digit delivery pincode required',
        code: 'INVALID_PINCODE'
      };
    }

    const res = await this.request({
      method: 'post',
      path: '/pincode-serviceability',
      data: {
        pickup_pincode: Number(pickup),
        delivery_pincode: Number(delivery)
      }
    });

    // API may succeed (result=1) while data.serviceable is false — treat that as a real answer.
    const flag = res.data?.serviceable;
    const serviceable = Boolean(res.ok && isShipmozoServiceableFlag(flag));
    return {
      ok: res.ok,
      serviceable,
      /** Explicit false from Shipmozo vs unknown/error (so callers can soft-fail). */
      explicitlyNotServiceable: Boolean(res.ok && flag != null && !isShipmozoServiceableFlag(flag)),
      message: res.message,
      code: res.code,
      pickupPincode: pickup,
      deliveryPincode: delivery,
      raw: res.raw
    };
  }

  /**
   * Rate calculator — returns courier list sorted by total charges ascending.
   */
  async rateCalculator({
    deliveryPincode,
    paymentType = 'PREPAID',
    shipmentType = 'FORWARD',
    orderAmount = 0,
    codAmount = '',
    weightGrams,
    lengthCm,
    widthCm,
    heightCm,
    orderId = '',
    storefront = 'ecomm'
  } = {}) {
    const cfg = await this.getConfig(storefront);
    const pickup = String(cfg.shipmozo?.pickupPincode || '')
      .replace(/\D/g, '')
      .slice(0, 6);
    const delivery = String(deliveryPincode || '')
      .replace(/\D/g, '')
      .slice(0, 6);

    if (pickup.length !== 6 || delivery.length !== 6) {
      return {
        ok: false,
        couriers: [],
        message: 'Valid pickup and delivery pincodes required',
        code: 'INVALID_PINCODE'
      };
    }

    const weight = Math.max(50, Number(weightGrams) || 500);
    const L = Math.max(1, Number(lengthCm) || 10);
    const W = Math.max(1, Number(widthCm) || 10);
    const H = Math.max(1, Number(heightCm) || 10);
    const pay = String(paymentType || 'PREPAID').toUpperCase() === 'COD' ? 'COD' : 'PREPAID';

    const res = await this.request({
      method: 'post',
      path: '/rate-calculator',
      data: {
        order_id: orderId || '',
        pickup_pincode: Number(pickup),
        delivery_pincode: Number(delivery),
        payment_type: pay,
        shipment_type: shipmentType || 'FORWARD',
        order_amount: roundMoney2(Number(orderAmount) || 0),
        type_of_package: 'SPS',
        rov_type: 'ROV_OWNER',
        cod_amount: pay === 'COD' ? String(codAmount || orderAmount || '') : '',
        weight,
        dimensions: [
          {
            no_of_box: '1',
            length: String(L),
            width: String(W),
            height: String(H)
          }
        ]
      },
      timeout: 30000
    });

    if (!res.ok) {
      return {
        ok: false,
        couriers: [],
        message: res.message || 'Rate calculator failed',
        code: res.code || 'SHIPMOZO_RATE_FAILED',
        raw: res.raw
      };
    }

    const rawList = this.extractCourierList(res.data);
    const couriers = rawList
      .map((c) => this.normalizeCourier(c))
      .filter((c) => c.courierId != null && Number.isFinite(c.totalCharges));

    couriers.sort((a, b) => a.totalCharges - b.totalCharges);

    return {
      ok: true,
      couriers,
      message: res.message || 'Success',
      pickupPincode: pickup,
      deliveryPincode: delivery,
      raw: res.raw
    };
  }

  extractCourierList(data) {
    if (!data) return [];
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.couriers)) return data.couriers;
    if (Array.isArray(data.courier_list)) return data.courier_list;
    if (Array.isArray(data.available_courier)) return data.available_courier;
    if (Array.isArray(data.data)) return data.data;
    if (data.courier && typeof data.courier === 'object') return [data.courier];
    // Some responses nest under rates / rate
    if (Array.isArray(data.rates)) return data.rates;
    if (Array.isArray(data.rate)) return data.rate;
    return [];
  }

  normalizeCourier(c) {
    if (!c || typeof c !== 'object') {
      return { courierId: null, courierName: null, totalCharges: NaN };
    }
    const courierId = Number(
      c.courier_id ?? c.courierId ?? c.id ?? c.company_id ?? c.courier_company_id
    );
    const courierName = String(
      c.courier_name || c.courier || c.name || c.courier_company || c.company_name || ''
    ).trim() || null;
    const freight = Number(
      c.total_charges ??
        c.totalCharges ??
        c.freight_charge ??
        c.freight ??
        c.rate ??
        c.shipping_charge ??
        c.charge ??
        0
    );
    const codFee = Number(c.cod_charges ?? c.cod_fee ?? c.codCharges ?? 0) || 0;
    const totalCharges = roundMoney2(freight);
    const etd =
      c.estimated_delivery_days != null
        ? String(c.estimated_delivery_days)
        : c.etd || c.estimated_delivery || c.delivery_days || null;
    const pickupsAuto = String(
      c.pickups_automatically_scheduled || c.pickup_automatically_scheduled || ''
    )
      .toUpperCase()
      .trim();

    return {
      courierId: Number.isFinite(courierId) ? courierId : null,
      courierName,
      totalCharges: Number.isFinite(totalCharges) ? totalCharges : NaN,
      freightInr: Number.isFinite(freight) ? roundMoney2(freight - (codFee > 0 && freight > codFee ? 0 : 0)) : null,
      codFeeInr: roundMoney2(codFee),
      estimatedDays: etd,
      pickupsAutomaticallyScheduled: pickupsAuto === 'YES' || pickupsAuto === 'TRUE' || pickupsAuto === '1',
      codAvailable:
        c.cod === true ||
        c.cod === 1 ||
        c.cod === 'YES' ||
        c.is_cod_available === true ||
        c.is_cod_available === 1 ||
        String(c.payment_type || '').toUpperCase().includes('COD') ||
        true,
      raw: c
    };
  }

  pickCheapestCourier(couriers, { codRequired = false } = {}) {
    const list = Array.isArray(couriers) ? couriers : [];
    let pool = list.filter((c) => c.courierId != null && Number.isFinite(c.totalCharges));
    if (codRequired) {
      const codPool = pool.filter((c) => c.codAvailable !== false);
      if (codPool.length) pool = codPool;
    }
    if (!pool.length) return null;
    return pool[0];
  }

  /**
   * Checkout-compatible quote (same shape as ShiprocketService.checkDeliveryAvailability).
   *
   * Source of truth: rate-calculator (bookable couriers + charges).
   * pincode-serviceability is advisory only — Shipmozo often returns
   * result=1 with serviceable=false even when rate-calculator returns couriers.
   */
  async checkDeliveryAvailability(deliveryPincode, opts = {}) {
    const storefront = opts.storefront === 'wholesale' ? 'wholesale' : 'ecomm';
    const pincode = String(deliveryPincode || '')
      .replace(/\D/g, '')
      .slice(0, 6);
    const weightKg = Math.max(0.05, Number(opts.weightKg) || 0.5);
    const lengthCm = Math.max(1, Number(opts.lengthCm) || 10);
    const widthCm = Math.max(1, Number(opts.widthCm) || 10);
    const heightCm = Math.max(1, Number(opts.heightCm) || 10);
    const codAmount = Math.max(0, Number(opts.codAmount) || 0);
    const orderAmount = Math.max(0, Number(opts.orderAmount) || codAmount || 0);

    if (pincode.length !== 6) {
      return emptyShipmozoQuote('Valid 6-digit pincode required', { code: 'INVALID_PINCODE' });
    }

    let configured = false;
    try {
      configured = await this.isConfigured();
    } catch (cfgErr) {
      logger.error('[Shipmozo] isConfigured failed during quote', { message: cfgErr.message });
      return emptyShipmozoQuote('Shipmozo configuration check failed', {
        code: 'SHIPMOZO_CONFIG_CHECK_FAILED'
      });
    }

    if (!configured) {
      return emptyShipmozoQuote(
        'Shipmozo is not fully configured (keys, warehouse, pickup pincode)',
        { code: 'SHIPMOZO_NOT_CONFIGURED' }
      );
    }

    // Soft probe — never blocks quoting if this endpoint lies / errors.
    let svcProbe = {
      ok: false,
      serviceable: false,
      explicitlyNotServiceable: false,
      message: null
    };
    try {
      svcProbe = await this.checkPincodeServiceability(pincode, storefront);
    } catch (svcErr) {
      logger.warn('[Shipmozo] pincode-serviceability probe failed (continuing with rates)', {
        pincode,
        message: svcErr.message
      });
    }

    try {
      const rates = await this.rateCalculator({
        deliveryPincode: pincode,
        paymentType: codAmount > 0 ? 'COD' : 'PREPAID',
        orderAmount: orderAmount || 1,
        codAmount: codAmount > 0 ? codAmount : '',
        weightGrams: kgToGrams(weightKg),
        lengthCm,
        widthCm,
        heightCm,
        storefront
      });

      if (!rates.ok) {
        const authish = /unauthori[sz]ed|forbidden|credential|api key|private key|public key/i.test(
          String(rates.message || '')
        );
        logger.warn('[Shipmozo] rate-calculator failed during quote', {
          pincode,
          message: rates.message,
          code: rates.code
        });
        return emptyShipmozoQuote(
          rates.message || 'Shipmozo rate calculator failed',
          {
            code: authish ? 'SHIPMOZO_AUTH_FAILED' : rates.code || 'SHIPMOZO_RATE_FAILED',
            pickupPincode: rates.pickupPincode || null,
            deliveryPincode: pincode
          }
        );
      }

      const couriers = Array.isArray(rates.couriers) ? rates.couriers : [];
      if (!couriers.length) {
        // No bookable courier — prefer clear not-serviceable wording for customer sanitize.
        const msg =
          svcProbe.explicitlyNotServiceable
            ? 'This pincode is currently not serviceable.'
            : rates.message || 'No courier available for this route';
        return emptyShipmozoQuote(msg, {
          code: 'NOT_SERVICEABLE',
          pickupPincode: rates.pickupPincode || null,
          deliveryPincode: pincode
        });
      }

      const picked = this.pickCheapestCourier(couriers, { codRequired: codAmount > 0 });
      if (!picked || !Number.isFinite(picked.totalCharges)) {
        return emptyShipmozoQuote('No courier available for this route', {
          code: 'NOT_SERVICEABLE',
          deliveryPincode: pincode
        });
      }

      if (svcProbe.explicitlyNotServiceable) {
        // Ops signal: serviceability API disagreed with rates (known Shipmozo quirk).
        logger.info('[Shipmozo] quote OK via rates despite serviceability=false', {
          pincode,
          courierId: picked.courierId,
          courierName: picked.courierName,
          totalCharges: picked.totalCharges,
          serviceabilityMessage: svcProbe.message || null
        });
      }

      const charges = Math.max(0, roundMoney2(picked.totalCharges));
      const codFee = Math.max(0, roundMoney2(picked.codFeeInr || 0));
      const freight = Math.max(
        0,
        roundMoney2(charges - (codFee > 0 && charges >= codFee ? codFee : 0))
      );

      return {
        isDeliverable: true,
        deliveryCharges: charges,
        freightInr: freight || charges,
        codFeeInr: codFee,
        estimatedDays: picked.estimatedDays || '3–5',
        courierName: picked.courierName,
        courierCompanyId: picked.courierId,
        shipmozoCourierId: picked.courierId,
        pickupsAutomaticallyScheduled: Boolean(picked.pickupsAutomaticallyScheduled),
        codAvailable: picked.codAvailable !== false,
        message: 'Delivery available',
        provider: 'shipmozo',
        shippingProvider: 'shipmozo',
        mock: false,
        couriers,
        pickupPincode: rates.pickupPincode || null,
        deliveryPincode: pincode,
        serviceabilityAdvisory: {
          ok: Boolean(svcProbe.ok),
          serviceable: Boolean(svcProbe.serviceable),
          explicitlyNotServiceable: Boolean(svcProbe.explicitlyNotServiceable)
        }
      };
    } catch (err) {
      logger.error('[Shipmozo] checkDeliveryAvailability failed', {
        pincode,
        message: err.message,
        stack: err.stack
      });
      return emptyShipmozoQuote(err.message || 'Shipmozo quote failed', {
        code: 'SHIPMOZO_QUOTE_EXCEPTION',
        deliveryPincode: pincode
      });
    }
  }

  async getDeliveryCharges(pincode, weightKg = 1, dimensionOpts = {}) {
    const r = await this.checkDeliveryAvailability(pincode, {
      weightKg,
      lengthCm: dimensionOpts.lengthCm,
      widthCm: dimensionOpts.widthCm,
      heightCm: dimensionOpts.heightCm,
      codAmount: dimensionOpts.codAmount,
      orderAmount: dimensionOpts.orderAmount
    });
    return {
      deliveryCharges: r.deliveryCharges,
      freightInr: r.freightInr != null ? r.freightInr : r.deliveryCharges,
      codFeeInr: Number(r.codFeeInr) || 0,
      isDeliverable: r.isDeliverable,
      estimatedDays: r.estimatedDays,
      courierName: r.courierName,
      courierCompanyId: r.courierCompanyId,
      shipmozoCourierId: r.shipmozoCourierId || r.courierCompanyId,
      codAvailable: r.codAvailable,
      message: r.message,
      provider: 'shipmozo',
      mock: r.mock
    };
  }

  /**
   * Build product + package parts for push-order (reuses weight snapshot when present).
   */
  async buildPushOrderParts(order) {
    const { resolveShiprocketPackageMetrics } = require('./shippingWeightSnapshot');
    const snapMetrics = await resolveShiprocketPackageMetrics(order);

    const productDetail = [];
    for (const item of order.items || []) {
      let name = 'Product';
      let sku = 'SKU';
      let unitPrice = Number(item.priceSnapshot?.sale ?? item.priceSnapshot?.total ?? item.priceSnapshot?.base) || 0;
      let hsn = item.hsnCode || '';

      if (item.productId) {
        const pid = mongoose.Types.ObjectId.isValid(item.productId)
          ? item.productId
          : item.productId?._id;
        if (pid) {
          const product =
            item.productId?.name != null && typeof item.productId === 'object'
              ? item.productId
              : await Product.findById(pid).lean();
          if (product) {
            name = product.name || name;
            const v = (product.variants || []).find((x) => String(x._id) === String(item.variantId));
            if (v?.sku) sku = v.sku;
          }
        }
      }

      productDetail.push({
        name,
        sku_number: sku,
        quantity: Math.max(1, Number(item.quantity) || 1),
        discount: '',
        hsn: hsn || '',
        unit_price: roundMoney2(unitPrice),
        product_category: 'Other'
      });
    }

    const addr = order.addressSnapshot || {};
    const totalWeightKg =
      snapMetrics?.totalWeightKg != null
        ? Number(snapMetrics.totalWeightKg)
        : Number(order.shippingWeightSnapshot?.totalWeightKg) || 0.5;
    const dims = snapMetrics?.dims || order.shippingWeightSnapshot?.dims || {};
    const lengthCm = Math.max(1, Number(dims.lengthCm) || 10);
    const widthCm = Math.max(1, Number(dims.widthCm) || 10);
    const heightCm = Math.max(1, Number(dims.heightCm) || 10);

    const payMethod = String(order.paymentInfo?.method || order.paymentMethod || '')
      .toLowerCase()
      .trim();
    const balanceViaCod =
      String(order.paymentInfo?.balanceCollectionMethod || '').toLowerCase() === 'cod';
    const totalInr = roundMoney2(Number(order.totalAmount) || 0);
    const paidInr = roundMoney2(Number(order.amountPaidInr) || 0);
    let balanceDue = roundMoney2(Math.max(0, Number(order.balanceDueInr) || 0));
    if (!(balanceDue > 0.005) && paidInr > 0.005 && totalInr > 0.005) {
      balanceDue = roundMoney2(Math.max(0, totalInr - paidInr));
    }
    const unpaidInr = roundMoney2(Math.max(0, totalInr - paidInr));
    if (balanceDue > unpaidInr + 0.005) {
      balanceDue = unpaidInr;
    }
    // Pure COD, or online advance with remaining COD due only (never full bill when prepaid covers).
    const useCodAtDoor =
      payMethod === 'cod' || (balanceViaCod && balanceDue > 0.005);
    const codCollect = useCodAtDoor
      ? payMethod === 'cod'
        ? totalInr
        : balanceDue
      : 0;

    return {
      productDetail,
      addr,
      totalWeightKg,
      weightGrams: kgToGrams(totalWeightKg),
      lengthCm,
      widthCm,
      heightCm,
      useCodAtDoor,
      paymentType: useCodAtDoor ? 'COD' : 'PREPAID',
      codAmount: useCodAtDoor ? String(codCollect) : '',
      orderAmount: totalInr
    };
  }

  /**
   * Push order to Shipmozo panel (admin accept).
   */
  async createShipment(order) {
    const storefront = order?.storefront === 'wholesale' ? 'wholesale' : 'ecomm';
    const configured = await this.isConfigured(storefront);
    if (!configured) {
      return {
        success: false,
        error: 'Shipmozo is not fully configured (keys, warehouse, pickup pincode)'
      };
    }

    const cfg = await this.getConfig(storefront);
    const warehouseId = String(cfg.shipmozo.warehouseId || '').trim();
    const parts = await this.buildPushOrderParts(order);
    const { addr, productDetail } = parts;

    const phone = String(addr.phone || '')
      .replace(/\D/g, '')
      .slice(-10);
    if (!phone || phone.length < 10) {
      return { success: false, error: 'Customer phone is required for Shipmozo push-order' };
    }

    const pin = String(addr.postalCode || '')
      .replace(/\D/g, '')
      .slice(0, 6);
    if (pin.length !== 6) {
      return { success: false, error: 'Customer pincode is required for Shipmozo push-order' };
    }

    const addressLineOne =
      [addr.houseNumber, addr.building, addr.floor, addr.addressLine1].filter(Boolean).join(', ') ||
      'Address';
    const addressLineTwo = [addr.addressLine2, addr.area, addr.landmark].filter(Boolean).join(', ') || '';

    const orderDate = (order.createdAt || new Date()).toISOString().slice(0, 10);

    const payload = {
      order_id: order.orderId,
      order_date: orderDate,
      order_type: 'ESSENTIALS',
      consignee_name: sanitizeCourierConsigneeName(addr.fullName),
      consignee_phone: Number(phone),
      consignee_alternate_phone: '',
      consignee_email: addr.email || process.env.STORE_EMAIL || '',
      consignee_address_line_one: addressLineOne,
      consignee_address_line_two: addressLineTwo,
      consignee_pin_code: Number(pin),
      consignee_city: addr.city || '',
      consignee_state: addr.state || '',
      product_detail: productDetail,
      payment_type: parts.paymentType,
      cod_amount: parts.codAmount,
      weight: parts.weightGrams,
      length: parts.lengthCm,
      width: parts.widthCm,
      height: parts.heightCm,
      warehouse_id: warehouseId,
      gst_ewaybill_number: '',
      gstin_number: ''
    };

    const res = await this.request({
      method: 'post',
      path: '/push-order',
      data: payload,
      timeout: 35000
    });

    if (!res.ok) {
      return {
        success: false,
        error: res.message || 'Shipmozo push-order failed',
        raw: res.raw
      };
    }

    const refId = String(res.data?.reference_id || res.data?.order_id || order.orderId);
    return {
      success: true,
      mock: false,
      // Reuse shipmentId slot so existing ops (hasShipmentId) work without SR-specific fields
      shipmentId: refId,
      shipmozoOrderId: String(res.data?.order_id || order.orderId),
      shipmozoReferenceId: refId,
      awbCode: null,
      trackingNumber: null,
      courier: null,
      providerStatus: 'PUSHED',
      raw: res.raw
    };
  }

  /**
   * Assign courier — prefers quoted courier id from checkout.
   */
  async assignCourier({ orderId, courierId }) {
    const oid = String(orderId || '').trim();
    const cid = Number(courierId);
    if (!oid) {
      return { success: false, code: 'ORDER_ID_REQUIRED', message: 'order_id required' };
    }
    if (!Number.isFinite(cid)) {
      return { success: false, code: 'COURIER_ID_REQUIRED', message: 'courier_id required' };
    }

    const res = await this.request({
      method: 'post',
      path: '/assign-courier',
      data: { order_id: oid, courier_id: cid },
      timeout: 30000
    });

    if (!res.ok) {
      return {
        success: false,
        code: res.code || 'ASSIGN_COURIER_FAILED',
        message: res.message || 'Assign courier failed',
        raw: res.raw
      };
    }

    const awb = res.data?.awb_number || res.data?.awb || null;
    return {
      success: true,
      orderId: res.data?.order_id || oid,
      referenceId: res.data?.reference_id || oid,
      courier: res.data?.courier || res.data?.courier_company || null,
      awbCode: awb ? String(awb) : null,
      trackingNumber: awb ? String(awb) : null,
      pickupsAutomaticallyScheduled: null,
      raw: res.raw
    };
  }

  async schedulePickup({ orderId }) {
    const oid = String(orderId || '').trim();
    if (!oid) {
      return { success: false, code: 'ORDER_ID_REQUIRED', message: 'order_id required' };
    }

    const res = await this.request({
      method: 'post',
      path: '/schedule-pickup',
      data: { order_id: oid },
      timeout: 30000
    });

    if (!res.ok) {
      return {
        success: false,
        code: res.code || 'SCHEDULE_PICKUP_FAILED',
        message: res.message || 'Schedule pickup failed',
        raw: res.raw
      };
    }

    const awb = res.data?.awb_number || res.data?.awb || null;
    return {
      success: true,
      orderId: res.data?.order_id || oid,
      referenceId: res.data?.reference_id || oid,
      courier: res.data?.courier || null,
      awbCode: awb ? String(awb) : null,
      trackingNumber: awb ? String(awb) : null,
      lrNumber: res.data?.lr_number || null,
      raw: res.raw
    };
  }

  async cancelOrder({ orderId, awbNumber }) {
    const oid = String(orderId || '').trim();
    const awb = String(awbNumber || '').trim();
    if (!oid || !awb) {
      return {
        success: false,
        code: 'CANCEL_PARAMS_REQUIRED',
        message: 'order_id and awb_number are required'
      };
    }

    const res = await this.request({
      method: 'post',
      path: '/cancel-order',
      data: {
        order_id: oid,
        awb_number: /^\d+$/.test(awb) ? Number(awb) : awb
      },
      timeout: 30000
    });

    if (!res.ok) {
      return {
        success: false,
        code: res.code || 'CANCEL_FAILED',
        message: res.message || 'Cancel failed',
        raw: res.raw
      };
    }

    return { success: true, raw: res.raw, message: res.message };
  }

  async getTrackingByAwb(awbCode) {
    const awb = String(awbCode || '').trim();
    if (!awb) {
      return { success: false, message: 'AWB required' };
    }

    const res = await this.request({
      method: 'get',
      path: '/track-order',
      params: { awb_number: awb },
      timeout: 20000
    });

    if (!res.ok) {
      return {
        success: false,
        message: res.message || 'Track failed',
        raw: res.raw
      };
    }

    const d = res.data || {};
    const scans = Array.isArray(d.scan_detail)
      ? d.scan_detail
      : Array.isArray(d.scans)
        ? d.scans
        : [];

    const events = scans.map((s) => ({
      status: s.status || s.current_status || s.scan_status || s.message || '',
      location: s.location || s.city || '',
      time: s.time || s.status_time || s.timestamp || s.date || null,
      raw: s
    }));

    return {
      success: true,
      currentStatus: d.current_status || d.status || null,
      awbCode: d.awb_number || awb,
      courier: d.courier || d.courier_name || null,
      estimatedDelivery: d.expected_delivery_date || null,
      orderId: d.order_id || null,
      events,
      raw: res.raw
    };
  }

  async getTracking({ awbCode } = {}) {
    return this.getTrackingByAwb(awbCode);
  }

  async getOrderLabel(awbNumber) {
    const awb = String(awbNumber || '').trim();
    if (!awb) {
      return { success: false, message: 'AWB required' };
    }

    const res = await this.request({
      method: 'get',
      path: `/get-order-label/${encodeURIComponent(awb)}`,
      timeout: 30000
    });

    if (!res.ok) {
      return {
        success: false,
        message: res.message || 'Label fetch failed',
        raw: res.raw
      };
    }

    const list = Array.isArray(res.data) ? res.data : res.data ? [res.data] : [];
    const first = list[0] || {};
    const label = first.label || first.label_url || null;

    return {
      success: Boolean(label),
      labelUrl: label,
      createdAt: first.created_at || null,
      raw: res.raw,
      message: label ? 'Success' : 'Label missing in response'
    };
  }

  async getOrderDetail(orderId) {
    const oid = String(orderId || '').trim();
    if (!oid) return { success: false, message: 'order_id required' };
    const res = await this.request({
      method: 'get',
      path: `/get-order-detail/${encodeURIComponent(oid)}`
    });
    return {
      success: res.ok,
      data: res.data,
      message: res.message,
      raw: res.raw
    };
  }

  async getWarehouses() {
    const res = await this.request({ method: 'get', path: '/get-warehouses' });
    const list = Array.isArray(res.data) ? res.data : [];
    return {
      success: res.ok,
      warehouses: list,
      message: res.message,
      raw: res.raw
    };
  }

  async createWarehouse(payload) {
    const res = await this.request({
      method: 'post',
      path: '/create-warehouse',
      data: payload || {},
      timeout: 30000
    });
    return {
      success: res.ok,
      warehouseId: res.data?.warehouse_id || null,
      message: res.message,
      raw: res.raw
    };
  }

  async getReturnReasons() {
    const res = await this.request({ method: 'get', path: '/get-return-reason' });
    return {
      success: res.ok,
      reasons: Array.isArray(res.data) ? res.data : [],
      message: res.message,
      raw: res.raw
    };
  }

  /**
   * List couriers for an existing pushed order (Ship Now fallback UI / substitutes).
   * Uses the same package + payment derivation as push-order for parity.
   * Does NOT pass marketplace order_id into rate-calculator by default — that can
   * return empty lists even when the pushed order is bookable in Shipmozo panel.
   */
  async listCouriersForOrder(order) {
    try {
      const parts = await this.buildPushOrderParts(order);
      const deliveryPin = String(parts.addr?.postalCode || '')
        .replace(/\D/g, '')
        .slice(0, 6);

      const rates = await this.rateCalculator({
        deliveryPincode: deliveryPin,
        paymentType: parts.paymentType,
        orderAmount: parts.orderAmount,
        codAmount: parts.codAmount,
        weightGrams: parts.weightGrams,
        lengthCm: parts.lengthCm,
        widthCm: parts.widthCm,
        heightCm: parts.heightCm,
        storefront: order?.storefront === 'wholesale' ? 'wholesale' : 'ecomm',
        // Empty order_id matches working checkout/Postman rate calls.
        orderId: ''
      });

      return {
        ...rates,
        paymentType: parts.paymentType,
        weightGrams: parts.weightGrams,
        deliveryPincode: deliveryPin
      };
    } catch (err) {
      logger.error('[Shipmozo] listCouriersForOrder failed', {
        orderId: order?.orderId,
        message: err.message
      });
      return {
        ok: false,
        couriers: [],
        message: err.message || 'Failed to list Shipmozo couriers',
        code: 'SHIPMOZO_RATE_FAILED',
        raw: null
      };
    }
  }

  /**
   * Push reverse/return order to Shipmozo.
   * weight in API doc for returns is listed as kg — we send kg here.
   */
  async pushReturnOrder(order, returnInfo = {}, opts = {}) {
    const parts = await this.buildPushOrderParts(order);
    const addr = parts.addr || {};
    const phone = String(addr.phone || '')
      .replace(/\D/g, '')
      .slice(-10);
    const pin = String(addr.postalCode || '')
      .replace(/\D/g, '')
      .slice(0, 6);
    const cfg = await this.getConfig(order?.storefront === 'wholesale' ? 'wholesale' : 'ecomm');
    const warehouseId = String(cfg.shipmozo?.warehouseId || '').trim();

    const returnReasonId = Number(opts.returnReasonId || returnInfo.shipmozoReturnReasonId || 14);
    const customerRequest = String(opts.customerRequest || returnInfo.customerRequest || 'REFUND').toUpperCase();

    const payload = {
      order_id: order.orderId,
      order_date: (order.createdAt || new Date()).toISOString().slice(0, 10),
      order_type: 'ESSENTIALS',
      pickup_name: sanitizeCourierConsigneeName(addr.fullName),
      pickup_phone: Number(phone) || 9999999999,
      pickup_email: addr.email || '',
      pickup_address_line_one:
        [addr.houseNumber, addr.building, addr.floor, addr.addressLine1].filter(Boolean).join(', ') ||
        'Address',
      pickup_address_line_two: [addr.addressLine2, addr.area, addr.landmark].filter(Boolean).join(', ') || '',
      pickup_pin_code: Number(pin) || 0,
      pickup_city: addr.city || '',
      pickup_state: addr.state || '',
      product_detail: parts.productDetail,
      payment_type: 'PREPAID',
      weight: Math.max(0.05, Number(parts.totalWeightKg) || 0.5),
      length: parts.lengthCm,
      width: parts.widthCm,
      height: parts.heightCm,
      warehouse_id: warehouseId || '',
      return_reason_id: Number.isFinite(returnReasonId) ? returnReasonId : 14,
      customer_request: customerRequest,
      reason_comment: String(returnInfo.reasonMessage || returnInfo.decisionReason || '')
    };

    const res = await this.request({
      method: 'post',
      path: '/push-return-order',
      data: payload,
      timeout: 35000
    });

    if (!res.ok) {
      return {
        success: false,
        error: res.message || 'Shipmozo push-return-order failed',
        raw: res.raw
      };
    }

    return {
      success: true,
      reverseShipmentId: String(res.data?.reference_id || res.data?.order_id || order.orderId),
      reverseAwbCode: res.data?.awb_number || null,
      reverseTrackingNumber: res.data?.awb_number || null,
      reverseCourier: res.data?.courier || null,
      providerStatus: 'return_pushed',
      raw: res.raw
    };
  }
}

module.exports = new ShipmozoService();
