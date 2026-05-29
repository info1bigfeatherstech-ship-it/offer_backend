/**
 * Shiprocket v2 API integration + safe mock fallback.
 * Serviceability drives server-side delivery fee (never trust client).
 */

const axios = require('axios');
const mongoose = require('mongoose');
const Product = require('../models/Product');
const logger = require('./logger');
const pickupCalendarUtil = require('./shiprocketPickupCalendar');

const DEFAULT_BASE = 'https://apiv2.shiprocket.in/v1';
const PICKUP_PREFS_CACHE_MS = 60 * 60 * 1000;

const roundMoney2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

class ShiprocketService {
  constructor() {
    this.baseURL = String(process.env.SHIPROCKET_BASE_URL || DEFAULT_BASE).replace(/\/$/, '');
    this.token = null;
    this.tokenExpiry = 0;
    this.authPromise = null;
    this.enabled = String(process.env.SHIPROCKET_ENABLED || '').toLowerCase() === 'true';
    this.pickupPreferencesCache = { at: 0, preferences: null };
  }

  getConfiguredPickupLocationNickname() {
    return String(process.env.SHIPROCKET_PICKUP_LOCATION || process.env.PICKUP_LOCATION_NICKNAME || '').trim();
  }

  static decodeJwtExpMs(token) {
    try {
      const payloadPart = token.split('.')[1];
      if (!payloadPart) return 0;
      const payloadJson = Buffer.from(payloadPart, 'base64').toString('utf8');
      const payload = JSON.parse(payloadJson);
      if (!payload.exp) return 0;
      return Number(payload.exp) * 1000;
    } catch (_) {
      return 0;
    }
  }

  mockQuote(pincode, weightKg = 0.5) {
    const pc = String(pincode || '').replace(/\D/g, '').slice(0, 6);
    if (pc.length !== 6) {
      return {
        isDeliverable: false,
        deliveryCharges: 0,
        estimatedDays: null,
        courierName: null,
        message: 'Invalid pincode',
        mock: true
      };
    }
    const w = Math.max(0.05, Number(weightKg) || 0.5);
    const base = 40 + Math.min(120, Math.round(w * 18));
    return {
      isDeliverable: true,
      deliveryCharges: base,
      estimatedDays: '3–5',
      courierName: 'Standard (mock)',
      message: 'Shiprocket disabled — using internal mock tariff',
      mock: true
    };
  }

  async getAuthToken({ forceRefresh = false } = {}) {
    if (!this.enabled) return null;
    const expiryBufferMs = 30 * 1000;
    if (!forceRefresh && this.token && this.tokenExpiry > Date.now() + expiryBufferMs) {
      return this.token;
    }

    if (this.authPromise) {
      return this.authPromise;
    }

    const email = String(process.env.SHIPROCKET_EMAIL || '').trim();
    const password = String(process.env.SHIPROCKET_PASSWORD || '').trim();
    if (!email || !password) {
      logger.warn('[Shiprocket] Missing SHIPROCKET_EMAIL / SHIPROCKET_PASSWORD');
      return null;
    }

    this.authPromise = (async () => {
      try {
        const { data } = await axios.post(
          `${this.baseURL}/external/auth/login`,
          { email, password },
          { timeout: 15000 }
        );

        const token = data?.token || null;
        if (!token) {
          this.token = null;
          this.tokenExpiry = 0;
          logger.error('[Shiprocket] auth failed: token missing in login response');
          return null;
        }

        this.token = token;
        const ttlSec = Number(data?.expires_in) || 0;
        const jwtExpiryMs = ShiprocketService.decodeJwtExpMs(token);
        const expiryFromTtl = ttlSec > 0 ? Date.now() + ttlSec * 1000 : 0;
        this.tokenExpiry = Math.max(expiryFromTtl, jwtExpiryMs, Date.now() + 24 * 60 * 60 * 1000);
        return this.token;
      } catch (err) {
        this.token = null;
        this.tokenExpiry = 0;
        logger.error('[Shiprocket] auth failed:', err.response?.data || err.message);
        return null;
      } finally {
        this.authPromise = null;
      }
    })();

    return this.authPromise;
  }

  async requestWithAuth(config, { retryOn401 = true } = {}) {
    const token = await this.getAuthToken();
    if (!token) return null;

    try {
      const { data } = await axios({
        ...config,
        timeout: config.timeout || 20000,
        headers: {
          ...(config.headers || {}),
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });
      return data;
    } catch (err) {
      const status = err?.response?.status;
      if (retryOn401 && status === 401) {
        const refreshedToken = await this.getAuthToken({ forceRefresh: true });
        if (!refreshedToken) {
          return null;
        }
        const { data } = await axios({
          ...config,
          timeout: config.timeout || 20000,
          headers: {
            ...(config.headers || {}),
            Authorization: `Bearer ${refreshedToken}`,
            'Content-Type': 'application/json'
          }
        });
        return data;
      }
      throw err;
    }
  }

  /**
   * @param {string} deliveryPincode
   * @param {object} opts
   * @param {number} opts.weightKg
   * @param {number} opts.lengthCm
   * @param {number} opts.widthCm
   * @param {number} opts.heightCm
   * @param {number} [opts.codAmount] — declared COD value for serviceability
   */
  async checkDeliveryAvailability(deliveryPincode, opts = {}) {
    const pincode = String(deliveryPincode || '').replace(/\D/g, '').slice(0, 6);
    const weight = Math.max(0.05, Number(opts.weightKg) || 0.5);
    const length = Math.max(1, Number(opts.lengthCm) || 10);
    const breadth = Math.max(1, Number(opts.widthCm) || 10);
    const height = Math.max(1, Number(opts.heightCm) || 10);
    const codAmount = Math.max(0, Number(opts.codAmount) || 0);

    if (pincode.length !== 6) {
      return {
        isDeliverable: false,
        deliveryCharges: 0,
        estimatedDays: null,
        courierName: null,
        message: 'Valid 6-digit pincode required'
      };
    }

    if (!this.enabled) {
      return this.mockQuote(pincode, weight);
    }

    const pickup = String(process.env.STORE_PINCODE || process.env.PICKUP_PINCODE || '560001').replace(/\D/g, '').slice(0, 6);

    try {
      const data = await this.requestWithAuth({
        method: 'get',
        url: `${this.baseURL}/external/courier/serviceability`,
        params: {
          pickup_postcode: pickup,
          delivery_postcode: pincode,
          weight,
          cod: codAmount > 0 ? 1 : 0,
          cod_amount: codAmount > 0 ? codAmount : undefined,
          length,
          breadth,
          height
        },
        timeout: 20000
      });
      if (!data) {
        // Auth flow failed or credentials missing; keep API stable via mock fallback.
        return this.mockQuote(pincode, weight);
      }

      const list = data?.data?.available_courier_companies || data?.data?.available_courier_list || [];
      if (!Array.isArray(list) || list.length === 0) {
        return {
          isDeliverable: false,
          deliveryCharges: 0,
          estimatedDays: null,
          courierName: null,
          message: 'No courier available for this route',
          mock: false
        };
      }

      const { filterActiveCouriers, pickCheapestActiveCourier } = require('../services/courierPolicy.service');
      const activeList = filterActiveCouriers(list);
      if (!activeList.length) {
        return {
          isDeliverable: false,
          deliveryCharges: 0,
          estimatedDays: null,
          courierName: null,
          message: 'No active courier available for this route (inactive couriers excluded)',
          mock: false
        };
      }

      const picked = pickCheapestActiveCourier(activeList, { codRequired: codAmount > 0 });
      if (!picked) {
        return {
          isDeliverable: false,
          deliveryCharges: 0,
          estimatedDays: null,
          courierName: null,
          message: 'No courier available for this route',
          mock: false
        };
      }
      const best = picked.courier;

      const rate = Number(best.rate ?? best.freight_charge ?? best.estimated_delivery_days) || 0;
      const days =
        best.estimated_delivery_days != null
          ? String(best.estimated_delivery_days)
          : best.etd || '3–5';

      const companyId = picked.courierCompanyId;

      return {
        isDeliverable: true,
        deliveryCharges: Math.max(0, rate),
        estimatedDays: days,
        courierName: picked.courierName,
        courierCompanyId: companyId,
        codAvailable:
          best.cod === 1 ||
          best.cod === true ||
          best.is_cod_available === 1 ||
          best.is_cod_available === true,
        message: 'Delivery available',
        mock: false
      };
    } catch (err) {
      logger.error('[Shiprocket] serviceability failed:', err.response?.data || err.message);
      return this.mockQuote(pincode, weight);
    }
  }

  async getDeliveryCharges(pincode, weightKg = 1, dimensionOpts = {}) {
    const r = await this.checkDeliveryAvailability(pincode, {
      weightKg,
      lengthCm: dimensionOpts.lengthCm,
      widthCm: dimensionOpts.widthCm,
      heightCm: dimensionOpts.heightCm,
      codAmount: dimensionOpts.codAmount
    });
    return {
      deliveryCharges: r.deliveryCharges,
      isDeliverable: r.isDeliverable,
      estimatedDays: r.estimatedDays,
      courierName: r.courierName,
      courierCompanyId: r.courierCompanyId,
      codAvailable: r.codAvailable,
      message: r.message,
      mock: r.mock
    };
  }

  /**
   * Line items + package metrics for adhoc create and courier serviceability (shared).
   */
  async buildAdhocPayloadParts(order) {
    const { resolveShiprocketPackageMetrics } = require('./shippingWeightSnapshot');
    const snapMetrics = await resolveShiprocketPackageMetrics(order);

    const orderItems = [];
    for (const item of order.items || []) {
      let length = 10;
      let breadth = 10;
      let height = 10;
      let weight = 0.5;
      let name = 'Product';
      let sku = 'SKU';

      if (item.productId) {
        const pid = mongoose.Types.ObjectId.isValid(item.productId) ? item.productId : item.productId?._id;
        if (pid) {
          const product = await Product.findById(pid).lean();
          if (product) {
            name = product.name || name;
            length = product.shipping?.dimensions?.length || length;
            breadth = product.shipping?.dimensions?.width || breadth;
            height = product.shipping?.dimensions?.height || height;
            weight = product.shipping?.weight || weight;
            const v = (product.variants || []).find((x) => String(x._id) === String(item.variantId));
            if (v?.sku) sku = v.sku;
          }
        }
      }

      if (snapMetrics?.lineWeightByVariantId?.has(String(item.variantId))) {
        weight = snapMetrics.lineWeightByVariantId.get(String(item.variantId));
      }

      const unit = Number(item.priceSnapshot?.sale ?? item.priceSnapshot?.base ?? 0);
      orderItems.push({
        name,
        sku,
        units: item.quantity,
        selling_price: unit,
        discount: 0,
        tax: item.gstRate != null ? item.gstRate : '',
        hsn: item.hsnCode || '',
        length,
        breadth,
        height,
        weight
      });
    }

    const addr = order.addressSnapshot || {};
    const totalWeight = snapMetrics
      ? snapMetrics.totalWeight
      : orderItems.reduce((s, it) => s + (Number(it.weight) || 0.5) * (Number(it.units) || 1), 0);
    const maxL = snapMetrics
      ? snapMetrics.maxL
      : Math.max(10, ...orderItems.map((i) => Number(i.length) || 0));
    const maxB = snapMetrics
      ? snapMetrics.maxB
      : Math.max(10, ...orderItems.map((i) => Number(i.breadth) || 0));
    const maxH = snapMetrics
      ? snapMetrics.maxH
      : Math.max(10, ...orderItems.map((i) => Number(i.height) || 0));

    const payMethod = String(order.paymentInfo?.method || '').toLowerCase();
    const balanceViaCod = String(order.paymentInfo?.balanceCollectionMethod || 'online').toLowerCase() === 'cod';
    const splitAdv = String(order.paymentInfo?.splitMode || 'full').toLowerCase() === 'advance';
    const useCodAtDoor =
      payMethod === 'cod' || (payMethod === 'online' && balanceViaCod && splitAdv);
    let codCollect = 0;
    if (useCodAtDoor && payMethod === 'online' && balanceViaCod) {
      codCollect = roundMoney2(order.balanceDueInr);
    }
    const codAmountForQuote =
      useCodAtDoor && payMethod === 'cod' ? roundMoney2(Number(order.totalAmount) || 0) : useCodAtDoor ? codCollect : 0;

    return {
      orderItems,
      addr,
      totalWeight: Math.max(0.05, totalWeight),
      maxL,
      maxB,
      maxH,
      useCodAtDoor,
      payMethod,
      balanceViaCod,
      splitAdv,
      codCollect,
      codAmountForQuote
    };
  }

  /**
   * Create Shiprocket forward shipment after payment (best-effort).
   */
  async createShipment(order) {
    if (!this.enabled) {
      return {
        success: true,
        mock: true,
        trackingNumber: `MOCK-${order.orderId}`,
        courier: 'Mock Courier'
      };
    }

    const pickupLocationRaw = String(process.env.SHIPROCKET_PICKUP_LOCATION || process.env.PICKUP_LOCATION_NICKNAME || '').trim();
    if (!pickupLocationRaw) {
      return {
        success: false,
        error:
          'Shiprocket pickup location is not configured. Set SHIPROCKET_PICKUP_LOCATION (pickup nickname from Shiprocket panel) and restart the server.'
      };
    }
    const pickupLocation = pickupLocationRaw;

    const parts = await this.buildAdhocPayloadParts(order);
    const { orderItems, addr, totalWeight, maxL, maxB, maxH, useCodAtDoor, payMethod, balanceViaCod, codCollect } =
      parts;
    const billingPhone = String(addr.phone || '').replace(/\D/g, '').slice(-10) || '9999999999';

    const payload = {
      order_id: order.orderId,
      order_date: (order.createdAt || new Date()).toISOString().slice(0, 19).replace('T', ' '),
      pickup_location: pickupLocation,
      billing_customer_name: addr.fullName || 'Customer',
      billing_last_name: '.',
      billing_address: addr.addressLine1 || 'Address',
      billing_address_2: addr.addressLine2 || '',
      billing_city: addr.city || '',
      billing_pincode: String(addr.postalCode || '').replace(/\D/g, '').slice(0, 6),
      billing_state: addr.state || '',
      billing_country: addr.country || 'India',
      billing_email: process.env.STORE_EMAIL || 'orders@example.com',
      billing_phone: billingPhone,
      shipping_is_billing: true,
      order_items: orderItems.map((it) => ({
        name: it.name,
        sku: it.sku,
        units: it.units,
        selling_price: it.selling_price,
        discount: it.discount,
        tax: it.tax,
        hsn: it.hsn
      })),
      payment_method: useCodAtDoor ? 'COD' : 'Prepaid',
      sub_total: Number(order.subtotal) || 0,
      shipping_charges: roundMoney2(Number(order.deliveryCharges) || 0),
      length: maxL,
      breadth: maxB,
      height: maxH,
      weight: totalWeight
    };

    if (useCodAtDoor && payMethod === 'online' && balanceViaCod) {
      if (codCollect > 0) {
        payload.order_total = codCollect;
      }
    }

    try {
      const data = await this.requestWithAuth({
        method: 'post',
        url: `${this.baseURL}/external/orders/create/adhoc`,
        data: payload,
        timeout: 30000
      });
      if (!data) {
        return { success: false, error: 'Shiprocket auth failed' };
      }
      return {
        success: true,
        shipmentId: data.shipment_id,
        shiprocketOrderId: data.order_id != null ? String(data.order_id) : null,
        awbCode: data.awb_code || data.tracking_number || null,
        trackingNumber: data.awb_code || data.tracking_number || null,
        courier: data.courier_name,
        labelUrl: data.label_url,
        providerStatus: data.status || null,
        raw: data,
        mock: false
      };
    } catch (err) {
      logger.error('[Shiprocket] createShipment failed:', err.response?.data || err.message);
      return { success: false, error: err.response?.data || err.message };
    }
  }

  /**
   * Create reverse pickup / return shipment.
   * Note: Shiprocket account configurations vary; endpoint is overridable via env.
   */
  async createReturnPickup(order, returnInfo = {}) {
    if (!this.enabled) {
      return {
        success: true,
        mock: true,
        reverseTrackingNumber: `MOCK-RET-${order.orderId}`,
        providerStatus: 'reverse_pickup_created'
      };
    }

    const configuredEndpoint = String(process.env.SHIPROCKET_RETURN_CREATE_ENDPOINT || '').trim();
    const endpointPath = configuredEndpoint || '/external/orders/create/return';
    const endpoint = endpointPath.startsWith('http') ? endpointPath : `${this.baseURL}${endpointPath}`;

    const payload = {
      order_id: order.orderId,
      shipment_id: order.shipmentInfo?.shipmentId || null,
      awb_code: order.shipmentInfo?.awbCode || order.shipmentInfo?.trackingNumber || null,
      reason: returnInfo.reasonType || 'damaged',
      remarks: returnInfo.reasonMessage || 'Return approved by admin',
      pickup_name: order.addressSnapshot?.fullName || 'Customer',
      pickup_phone: String(order.addressSnapshot?.phone || '').replace(/\D/g, '').slice(-10) || undefined,
      pickup_address: order.addressSnapshot?.addressLine1 || order.addressSnapshot?.area || undefined,
      pickup_address_2: order.addressSnapshot?.addressLine2 || undefined,
      pickup_city: order.addressSnapshot?.city || undefined,
      pickup_state: order.addressSnapshot?.state || undefined,
      pickup_pincode: String(order.addressSnapshot?.postalCode || '').replace(/\D/g, '').slice(0, 6) || undefined,
      pickup_country: order.addressSnapshot?.country || 'India'
    };

    try {
      const data = await this.requestWithAuth({
        method: 'post',
        url: endpoint,
        data: payload,
        timeout: 30000
      });

      if (!data) {
        return { success: false, error: 'Shiprocket auth failed' };
      }

      return {
        success: true,
        reverseShipmentId: data.shipment_id || data.return_id || null,
        reverseAwbCode: data.awb_code || data.tracking_number || null,
        reverseTrackingNumber: data.tracking_number || data.awb_code || null,
        reverseCourier: data.courier_name || null,
        providerStatus: data.status || data.current_status || 'reverse_pickup_created',
        raw: data,
        mock: false
      };
    } catch (err) {
      logger.error('[Shiprocket] createReturnPickup failed:', err.response?.data || err.message);
      return { success: false, error: err.response?.data || err.message };
    }
  }

  normalizeTrackingResponse(rawData) {
    const root = rawData?.tracking_data || rawData?.data || rawData || {};
    const shipmentTrack = root?.shipment_track || [];
    const shipmentTrackItem = Array.isArray(shipmentTrack) ? shipmentTrack[0] : shipmentTrack;
    const activities = root?.shipment_track_activities || root?.activities || [];
    const events = Array.isArray(activities)
      ? activities.map((entry) => ({
          status: entry?.sr_status_label || entry?.status || entry?.activity || entry?.message || null,
          code: entry?.sr_status || entry?.status_code || null,
          location: entry?.location || entry?.city || null,
          description: entry?.activity || entry?.message || entry?.status || null,
          at: entry?.date || entry?.datetime || entry?.time || null,
          raw: entry
        }))
      : [];

    return {
      success: true,
      awbCode:
        root?.awb_code ||
        shipmentTrackItem?.awb_code ||
        shipmentTrackItem?.awb ||
        null,
      shipmentId:
        root?.shipment_id ||
        shipmentTrackItem?.shipment_id ||
        null,
      courier:
        shipmentTrackItem?.courier_name ||
        shipmentTrackItem?.courier ||
        root?.courier_name ||
        null,
      currentStatus:
        root?.current_status ||
        shipmentTrackItem?.current_status ||
        shipmentTrackItem?.status ||
        null,
      estimatedDelivery:
        shipmentTrackItem?.etd ||
        root?.etd ||
        null,
      events,
      raw: rawData
    };
  }

  async getTrackingByAwb(awbCode) {
    const awb = String(awbCode || '').trim();
    if (!awb) {
      return { success: false, code: 'TRACKING_AWB_REQUIRED', message: 'awbCode is required' };
    }
    if (!this.enabled) {
      return { success: false, code: 'SHIPROCKET_DISABLED', message: 'Shiprocket is disabled' };
    }

    try {
      const data = await this.requestWithAuth({
        method: 'get',
        url: `${this.baseURL}/external/courier/track/awb/${encodeURIComponent(awb)}`,
        timeout: 20000
      });
      if (!data) {
        return { success: false, code: 'SHIPROCKET_AUTH_FAILED', message: 'Shiprocket auth failed' };
      }
      return this.normalizeTrackingResponse(data);
    } catch (err) {
      logger.error('[Shiprocket] getTrackingByAwb failed:', err.response?.data || err.message);
      return {
        success: false,
        code: 'SHIPROCKET_TRACK_FAILED',
        message: err.response?.data?.message || err.message || 'Failed to fetch tracking by AWB'
      };
    }
  }

  async getTrackingByShipmentId(shipmentId) {
    const normalized = String(shipmentId || '').trim();
    if (!normalized) {
      return { success: false, code: 'TRACKING_SHIPMENT_ID_REQUIRED', message: 'shipmentId is required' };
    }
    if (!this.enabled) {
      return { success: false, code: 'SHIPROCKET_DISABLED', message: 'Shiprocket is disabled' };
    }

    try {
      const data = await this.requestWithAuth({
        method: 'get',
        url: `${this.baseURL}/external/courier/track/shipment/${encodeURIComponent(normalized)}`,
        timeout: 20000
      });
      if (!data) {
        return { success: false, code: 'SHIPROCKET_AUTH_FAILED', message: 'Shiprocket auth failed' };
      }
      return this.normalizeTrackingResponse(data);
    } catch (err) {
      logger.error('[Shiprocket] getTrackingByShipmentId failed:', err.response?.data || err.message);
      return {
        success: false,
        code: 'SHIPROCKET_TRACK_FAILED',
        message: err.response?.data?.message || err.message || 'Failed to fetch tracking by shipment id'
      };
    }
  }

  async getTracking({ awbCode, shipmentId } = {}) {
    if (awbCode) {
      return this.getTrackingByAwb(awbCode);
    }
    if (shipmentId) {
      return this.getTrackingByShipmentId(shipmentId);
    }
    return { success: false, code: 'TRACKING_REFERENCE_MISSING', message: 'awbCode or shipmentId is required' };
  }

  static formatAxiosError(err) {
    const d = err?.response?.data;
    if (d && typeof d === 'object') {
      if (Array.isArray(d.errors) && d.errors.length) {
        return String(d.errors[0]?.message || d.errors[0] || d.message || JSON.stringify(d)).slice(0, 800);
      }
      if (d.message) return String(d.message);
      return JSON.stringify(d).slice(0, 800);
    }
    return err?.message ? String(err.message) : String(err);
  }

  parseNumericShipmentId(shipmentId) {
    const n = Number(String(shipmentId ?? '').trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  /** Shiprocket channel order id (numeric) — used for print/invoice, cancel, etc. */
  parseNumericShiprocketOrderId(orderId) {
    const n = Number(String(orderId ?? '').trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  /** Today UTC as YYYY-MM-DD (courier pickup plausibility window). */
  static todayYmdUtc() {
    return new Date().toISOString().slice(0, 10);
  }

  static addDaysYmd(ymd, days) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || '').trim());
    if (!m) return null;
    const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    dt.setUTCDate(dt.getUTCDate() + Number(days));
    return dt.toISOString().slice(0, 10);
  }

  /** Calendar-valid YYYY-MM-DD within a realistic courier pickup window. */
  static isPlausibleCourierPickupYmd(ymd, opts = {}) {
    const s = String(ymd || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [y, mo, d] = s.split('-').map(Number);
    if (y < 2020 || y > 2035 || mo < 1 || mo > 12 || d < 1 || d > 31) return false;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
      return false;
    }
    const today = opts.todayYmd || ShiprocketService.todayYmdUtc();
    const min = opts.minYmd || ShiprocketService.addDaysYmd(today, -14);
    const max = opts.maxYmd || ShiprocketService.addDaysYmd(today, 120);
    return Boolean(min && max && s >= min && s <= max);
  }

  /** Unix seconds/ms → YYYY-MM-DD only when the result is a plausible courier pickup day. */
  static parseUnixTimestampToYmd(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    let ms = null;
    if (n >= 1e12) ms = n;
    else if (n >= 1e9) ms = n * 1000;
    if (ms == null) return null;
    const ymd = new Date(ms).toISOString().slice(0, 10);
    return ShiprocketService.isPlausibleCourierPickupYmd(ymd) ? ymd : null;
  }

  /**
   * Normalize admin/API date strings to YYYY-MM-DD (ISO or DD-MM-YYYY only).
   * Does not use loose Date(string) parsing.
   */
  static normalizeYmdDate(value) {
    if (value == null || value === '') return null;
    const s = String(value).trim();
    const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (iso) {
      const ymd = `${iso[1]}-${iso[2]}-${iso[3]}`;
      return ShiprocketService.isValidCalendarYmd(ymd) ? ymd : null;
    }
    const dmy = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s);
    if (dmy) {
      const ymd = `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
      return ShiprocketService.isValidCalendarYmd(ymd) ? ymd : null;
    }
    return null;
  }

  static isValidCalendarYmd(ymd) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || '').trim());
    if (!m) return false;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
  }

  /**
   * Authoritative parser for Shiprocket courier pickup day fields only.
   * Whitelist: ISO / DD-MM-YYYY / unix timestamp / "For 18 May 2026" in status copy.
   */
  static parseCourierPickupDateValue(value) {
    if (value == null || value === '') return null;
    if (typeof value === 'number' || /^\d{9,13}$/.test(String(value).trim())) {
      return ShiprocketService.parseUnixTimestampToYmd(value);
    }
    const s = String(value).trim();
    const fromToken = ShiprocketService.parseShiprocketDateToken(s);
    if (fromToken && ShiprocketService.isPlausibleCourierPickupYmd(fromToken)) return fromToken;
    const fromHuman = ShiprocketService.parsePickupDateFromHumanText(s);
    if (fromHuman && ShiprocketService.isPlausibleCourierPickupYmd(fromHuman)) return fromHuman;
    const fromNorm = ShiprocketService.normalizeYmdDate(s);
    if (fromNorm && ShiprocketService.isPlausibleCourierPickupYmd(fromNorm)) return fromNorm;
    return null;
  }

  static normalizeForwardOrderRoot(data) {
    if (!data || typeof data !== 'object') return null;
    if (data.data && typeof data.data === 'object' && !Array.isArray(data.data)) {
      return data.data;
    }
    return data;
  }

  /** Shiprocket orders/show returns shipments as an array OR a single object. */
  static getPrimaryShipment(root) {
    if (!root || typeof root !== 'object') return null;
    const s = root.shipments;
    if (Array.isArray(s)) {
      return s.find((row) => row && typeof row === 'object') || null;
    }
    if (s && typeof s === 'object') return s;
    return null;
  }

  static monthDayYearToYmd(day, monthToken, year) {
    const months = {
      jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
      jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
    };
    const mon = months[String(monthToken || '').slice(0, 3).toLowerCase()];
    if (!mon) return null;
    const ymd = `${year}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return ShiprocketService.isValidCalendarYmd(ymd) ? ymd : null;
  }

  /** Shiprocket date tokens: 18-May-2026, 18th May 2026, For 18 May 2026. */
  static parseShiprocketDateToken(value) {
    const s = String(value || '').trim();
    if (!s) return null;
    const forMatch = /for\s+(\d{1,2})\s+([a-z]+)\s+(\d{4})/i.exec(s);
    if (forMatch) {
      return ShiprocketService.monthDayYearToYmd(forMatch[1], forMatch[2], forMatch[3]);
    }
    const dMonY = /^(\d{1,2})-([a-z]+)-(\d{4})$/i.exec(s);
    if (dMonY) {
      return ShiprocketService.monthDayYearToYmd(dMonY[1], dMonY[2], dMonY[3]);
    }
    const dMonYsp = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\s+(\d{4})$/i.exec(s);
    if (dMonYsp) {
      return ShiprocketService.monthDayYearToYmd(dMonYsp[1], dMonYsp[2], dMonYsp[3]);
    }
    const dMonYplain = /^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/i.exec(s);
    if (dMonYplain) {
      return ShiprocketService.monthDayYearToYmd(dMonYplain[1], dMonYplain[2], dMonYplain[3]);
    }
    return null;
  }

  /**
   * Map GET /external/orders/show/{id} payload to a stable snapshot for DB sync.
   * @param {object|null} root — normalized order object from Shiprocket
   */
  static extractForwardOrderSnapshot(root) {
    if (!root || typeof root !== 'object') return null;

    const sh0 = ShiprocketService.getPrimaryShipment(root) || {};

    const shiprocketOrderIdRaw =
      root.id ?? root.order_id ?? root.shiprocket_order_id ?? root.channel_order_id ?? null;
    const shipmentIdRaw =
      root.shipment_id ??
      root.shipmentId ??
      sh0.id ??
      sh0.shipment_id ??
      null;

    const awbCode = root.awb ?? root.awb_code ?? sh0.awb ?? sh0.awb_code ?? null;
    const trackingNumber =
      awbCode ||
      root.tracking_number ||
      root.awb ||
      sh0.tracking_number ||
      sh0.awb_code ||
      null;
    const courier =
      root.courier_name ?? sh0.courier_name ?? sh0.courier ?? root.courier ?? null;
    const labelUrl = root.label_url ?? sh0.label_url ?? null;
    const manifestUrl =
      root.manifest_url ??
      sh0.manifest_url ??
      root.manifest ??
      sh0.manifest ??
      null;

    const pickupDate = ShiprocketService.extractStrictPickupScheduledDateFromOrderShow(root);

    const statusCodeRaw = root.status_code ?? root.current_status_id ?? sh0.status ?? sh0.status_code;
    const statusCode = Number(statusCodeRaw);
    const statusLabel = String(
      root.status ??
        root.shipment_status ??
        root.current_status ??
        sh0.status ??
        root.sr_status_label ??
        ''
    ).trim();

    const {
      collectForwardOrderTexts,
      detectForwardOrderReset
    } = require('../services/shipmentOps/shiprocketStatusMap');
    const signalTexts = collectForwardOrderTexts(root, sh0);
    const statusMessage = [
      root.status_message,
      root.message,
      root.comment,
      root.remark,
      sh0.status_message,
      sh0.message,
      sh0.comment,
      sh0.remark
    ]
      .map((x) => (x != null ? String(x).trim() : ''))
      .filter(Boolean)
      .join(' · ');

    const resetInfo = detectForwardOrderReset({
      statusCode: Number.isFinite(statusCode) ? statusCode : null,
      statusLabel,
      statusMessage: statusMessage || null,
      texts: signalTexts,
      awbCode: awbCode != null && String(awbCode).trim() ? String(awbCode).trim() : null,
      hadLocalAwb: false
    });

    const pickupScheduled =
      Boolean(pickupDate) ||
      statusCode === 4 ||
      statusCode === 12 ||
      statusCode === 13 ||
      statusCode === 14 ||
      statusCode === 15 ||
      /pickup\s*scheduled|pickup\s*queued|in\s+pickup\s+queue|manifested/i.test(statusLabel);

    const providerStatus = statusLabel || (pickupScheduled ? 'pickup_scheduled' : null);

    const providerSnapshot = {
      statusCode: Number.isFinite(statusCode) ? statusCode : null,
      statusLabel: providerStatus,
      statusMessage: statusMessage || null,
      awbCode: awbCode != null && String(awbCode).trim() ? String(awbCode).trim() : null,
      pickupScheduled,
      resetDetected: resetInfo.resetDetected,
      resetReason: resetInfo.reason,
      syncedAt: new Date().toISOString()
    };

    return {
      shiprocketOrderId:
        shiprocketOrderIdRaw != null && String(shiprocketOrderIdRaw).trim()
          ? String(shiprocketOrderIdRaw).trim()
          : null,
      shipmentId:
        shipmentIdRaw != null && String(shipmentIdRaw).trim() ? String(shipmentIdRaw).trim() : null,
      awbCode: awbCode != null && String(awbCode).trim() ? String(awbCode).trim() : null,
      trackingNumber:
        trackingNumber != null && String(trackingNumber).trim()
          ? String(trackingNumber).trim()
          : null,
      courier: courier != null && String(courier).trim() ? String(courier).trim() : null,
      labelUrl: labelUrl != null && String(labelUrl).trim() ? String(labelUrl).trim() : null,
      manifestUrl: manifestUrl != null && String(manifestUrl).trim() ? String(manifestUrl).trim() : null,
      pickupDate,
      pickupScheduled,
      providerStatus,
      statusCode: Number.isFinite(statusCode) ? statusCode : null,
      statusMessage: statusMessage || null,
      signalTexts,
      resetDetected: resetInfo.resetDetected,
      resetReason: resetInfo.reason,
      providerSnapshot,
      raw: root
    };
  }

  static isPickupAlreadyScheduledMessage(message) {
    const msg = String(message || '').toLowerCase();
    return (
      /pickup\s+(?:is\s+)?already\s+scheduled/.test(msg) ||
      /already\s+(?:been\s+)?scheduled/.test(msg) ||
      /pickup\s+date\s+scheduled\s+already/.test(msg) ||
      /pickup\s+has\s+already\s+been\s+generated/.test(msg) ||
      /already\s+in\s+pickup\s+queue/.test(msg) ||
      /in\s+pickup\s+queue/.test(msg) ||
      /pickup\s+queue/.test(msg) ||
      /pickup\s+scheduled/.test(msg)
    );
  }

  /** Parse "For 18 May 2026" from Shiprocket panel copy — explicit pattern only. */
  static parsePickupDateFromHumanText(value) {
    return ShiprocketService.parseShiprocketDateToken(value);
  }

  /**
   * orders/show — whitelist fields + pickup_status copy only (never pickup_date / generic status).
   */
  static extractStrictPickupScheduledDateFromOrderShow(root) {
    if (!root || typeof root !== 'object') return null;
    const sh0 = ShiprocketService.getPrimaryShipment(root) || {};
    const fieldCandidates = [
      root.pickup_scheduled_date,
      root.pickup_schedule_date,
      sh0.pickup_scheduled_date,
      sh0.pickup_schedule_date,
      root.response?.pickup_scheduled_date,
      sh0.response?.pickup_scheduled_date
    ];
    for (const c of fieldCandidates) {
      const parsed = ShiprocketService.parseCourierPickupDateValue(c);
      if (parsed) return parsed;
    }
    const statusText = [root.pickup_status, sh0.pickup_status].filter(Boolean).join(' ');
    const fromStatus = ShiprocketService.parsePickupDateFromHumanText(statusText);
    return fromStatus && ShiprocketService.isPlausibleCourierPickupYmd(fromStatus) ? fromStatus : null;
  }

  /** @deprecated tests only — use parseCourierPickupDateValue in production paths. */
  static extractPickupDateDeepFromRoot(root) {
    if (!root || typeof root !== 'object') return null;
    return ShiprocketService.extractStrictPickupScheduledDateFromOrderShow(root);
  }

  /** Schedule API response — whitelist fields + pickup_status copy; fallback only if plausible. */
  static parsePickupDateFromScheduleResponse(raw, fallbackYmd) {
    if (raw && typeof raw === 'object') {
      const candidates = [
        raw.pickup_scheduled_date,
        raw.pickup_schedule_date,
        raw.response?.pickup_scheduled_date,
        raw.response?.pickup_schedule_date,
        Array.isArray(raw.pickup_scheduled_dates) ? raw.pickup_scheduled_dates[0] : null
      ];
      for (const c of candidates) {
        const parsed = ShiprocketService.parseCourierPickupDateValue(c);
        if (parsed) return parsed;
      }
      const statusText = [raw.pickup_status, raw.response?.pickup_status].filter(Boolean).join(' ');
      const fromStatus = ShiprocketService.parsePickupDateFromHumanText(statusText);
      if (fromStatus && ShiprocketService.isPlausibleCourierPickupYmd(fromStatus)) return fromStatus;
    }
    const fb = ShiprocketService.normalizeYmdDate(fallbackYmd);
    return fb && ShiprocketService.isPlausibleCourierPickupYmd(fb) ? fb : null;
  }

  /**
   * Courier list for route (same serviceability API as checkout).
   * @returns {{ success: boolean, couriers?: array, message?: string, mock?: boolean }}
   */
  async listCouriersForRoute(deliveryPincode, opts = {}) {
    const pincode = String(deliveryPincode || '').replace(/\D/g, '').slice(0, 6);
    const weight = Math.max(0.05, Number(opts.weightKg) || 0.5);
    const length = Math.max(1, Number(opts.lengthCm) || 10);
    const breadth = Math.max(1, Number(opts.widthCm) || 10);
    const height = Math.max(1, Number(opts.heightCm) || 10);
    const codAmount = Math.max(0, Number(opts.codAmount) || 0);

    if (pincode.length !== 6) {
      return { success: false, message: 'Valid 6-digit delivery pincode required' };
    }
    if (!this.enabled) {
      return {
        success: true,
        mock: true,
        couriers: [
          {
            courier_company_id: 0,
            courier_name: 'Mock Courier',
            rate: 60,
            estimated_delivery_days: 3,
            cod: 1
          }
        ]
      };
    }

    const pickup = String(process.env.STORE_PINCODE || process.env.PICKUP_PINCODE || '560001').replace(/\D/g, '').slice(0, 6);
    try {
      const data = await this.requestWithAuth({
        method: 'get',
        url: `${this.baseURL}/external/courier/serviceability`,
        params: {
          pickup_postcode: pickup,
          delivery_postcode: pincode,
          weight,
          cod: codAmount > 0 ? 1 : 0,
          cod_amount: codAmount > 0 ? codAmount : undefined,
          length,
          breadth,
          height
        },
        timeout: 20000
      });
      if (!data) {
        return { success: false, message: 'Shiprocket auth failed' };
      }
      const list = data?.data?.available_courier_companies || data?.data?.available_courier_list || [];
      if (!Array.isArray(list) || list.length === 0) {
        return { success: false, message: 'No courier available for this route' };
      }
      return { success: true, couriers: list };
    } catch (err) {
      logger.error('[Shiprocket] listCouriersForRoute failed:', err.response?.data || err.message);
      return { success: false, message: ShiprocketService.formatAxiosError(err) };
    }
  }

  /**
   * Pick recommended courier_id: cheapest rate among COD-eligible (if COD) else all; tie-break by faster ETD.
   */
  pickRecommendedCourierId(couriers, { codRequired }) {
    const { pickCheapestActiveCourier } = require('../services/courierPolicy.service');
    const picked = pickCheapestActiveCourier(couriers, { codRequired });
    return picked?.courierCompanyId ?? null;
  }

  /**
   * POST /external/courier/assign/awb — panel "Ship Now" equivalent.
   * @see https://apidocs.shiprocket.in/
   */
  async assignAwb({ shipmentId, courierId = null }) {
    const sid = this.parseNumericShipmentId(shipmentId);
    if (!sid) {
      return { success: false, code: 'INVALID_SHIPMENT_ID', message: 'Valid shipment_id is required' };
    }
    if (!this.enabled) {
      return {
        success: true,
        mock: true,
        awbCode: `MOCK-AWB-${sid}`,
        trackingNumber: `MOCK-AWB-${sid}`,
        courier: 'Mock Courier',
        labelUrl: null,
        providerStatus: 'mock_assigned',
        raw: { mock: true }
      };
    }
    if (courierId == null || !Number.isFinite(Number(courierId))) {
      return { success: false, code: 'COURIER_ID_REQUIRED', message: 'courier_id is required for assign AWB' };
    }
    try {
      const data = await this.requestWithAuth({
        method: 'post',
        url: `${this.baseURL}/external/courier/assign/awb`,
        data: {
          shipment_id: sid,
          courier_id: Number(courierId)
        },
        timeout: 30000
      });
      if (!data) {
        return { success: false, code: 'SHIPROCKET_AUTH_FAILED', message: 'Shiprocket auth failed' };
      }

      const nested = data.response?.data && typeof data.response.data === 'object' ? data.response.data : {};
      const awbCode =
        data.awb_code ||
        nested.awb_code ||
        data.awb ||
        nested.awb ||
        null;
      const trackingNumber =
        data.tracking_number ||
        nested.tracking_number ||
        awbCode ||
        null;
      const courierName = data.courier_name || nested.courier_name || null;
      const labelUrl = data.label_url || nested.label_url || null;

      const awbAssignStatus = data.awb_assign_status != null ? Number(data.awb_assign_status) : null;
      const statusCode = data.status_code != null ? Number(data.status_code) : null;

      const hasAwb = Boolean(String(awbCode || trackingNumber || '').trim());
      /** Shiprocket often returns HTTP 200 with awb_assign_status 0 and a wallet / rules message when no AWB is issued. */
      const assignSucceeded = hasAwb || awbAssignStatus === 1;
      const errMsg =
        nested.awb_assign_error ||
        data.awb_error ||
        (typeof data.payload === 'string' ? data.payload : null) ||
        data.message ||
        'Shiprocket did not return an AWB. Recharge the Shiprocket wallet or check courier availability.';

      if (!assignSucceeded) {
        const walletish =
          statusCode === 350 ||
          /recharge|wallet|balance|insufficient/i.test(String(errMsg || ''));
        return {
          success: false,
          code: walletish ? 'SHIPROCKET_WALLET_OR_BALANCE' : 'ASSIGN_AWB_NOT_COMPLETED',
          message: errMsg,
          details: data,
          awbCode: null,
          trackingNumber: null,
          courier: null,
          labelUrl: null,
          providerStatus: 'assignment_failed',
          raw: data,
          mock: false
        };
      }

      return {
        success: true,
        awbCode: awbCode || null,
        trackingNumber: trackingNumber || null,
        courier: courierName,
        labelUrl,
        providerStatus: 'assigned',
        raw: data,
        mock: false
      };
    } catch (err) {
      logger.error('[Shiprocket] assignAwb failed:', err.response?.data || err.message);
      return {
        success: false,
        code: 'ASSIGN_AWB_FAILED',
        message: ShiprocketService.formatAxiosError(err),
        details: err.response?.data || null
      };
    }
  }

  /**
   * POST /external/courier/generate/pickup — scheduled pickup (date required).
   * @see https://apidocs.shiprocket.in/
   */
  async schedulePickup({ shipmentId, pickupDate }) {
    const sid = this.parseNumericShipmentId(shipmentId);
    if (!sid) {
      return { success: false, code: 'INVALID_SHIPMENT_ID', message: 'Valid shipment_id is required' };
    }
    const dateStr = String(pickupDate || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return { success: false, code: 'INVALID_PICKUP_DATE', message: 'pickupDate must be YYYY-MM-DD' };
    }
    if (!this.enabled) {
      return {
        success: true,
        mock: true,
        pickupDate: dateStr,
        providerStatus: 'pickup_scheduled_mock',
        raw: { mock: true }
      };
    }
    try {
      const data = await this.requestWithAuth({
        method: 'post',
        url: `${this.baseURL}/external/courier/generate/pickup`,
        data: {
          shipment_id: sid,
          pickup_date: [dateStr]
        },
        timeout: 30000
      });
      if (!data) {
        return { success: false, code: 'SHIPROCKET_AUTH_FAILED', message: 'Shiprocket auth failed' };
      }
      const confirmedDate = ShiprocketService.parsePickupDateFromScheduleResponse(data, null);
      return {
        success: true,
        requestedPickupDate: dateStr,
        pickupDate: confirmedDate,
        dateAdjusted: Boolean(confirmedDate && confirmedDate !== dateStr),
        providerStatus: data.pickup_status || data.status || 'pickup_scheduled',
        raw: data,
        mock: false
      };
    } catch (err) {
      logger.error('[Shiprocket] schedulePickup failed:', err.response?.data || err.message);
      return {
        success: false,
        code: 'PICKUP_SCHEDULE_FAILED',
        message: ShiprocketService.formatAxiosError(err),
        details: err.response?.data || null
      };
    }
  }

  /**
   * POST /external/courier/generate/pickup — retry failed pickup (status: retry).
   * @see https://apidocs.shiprocket.in/
   */
  async retryPickup({ shipmentId }) {
    const sid = this.parseNumericShipmentId(shipmentId);
    if (!sid) {
      return { success: false, code: 'INVALID_SHIPMENT_ID', message: 'Valid shipment_id is required' };
    }
    if (!this.enabled) {
      return {
        success: true,
        mock: true,
        providerStatus: 'pickup_retry_mock',
        raw: { mock: true, status: 'retry' }
      };
    }
    try {
      const data = await this.requestWithAuth({
        method: 'post',
        url: `${this.baseURL}/external/courier/generate/pickup`,
        data: {
          shipment_id: sid,
          status: 'retry'
        },
        timeout: 30000
      });
      if (!data) {
        return { success: false, code: 'SHIPROCKET_AUTH_FAILED', message: 'Shiprocket auth failed' };
      }
      const confirmedDate = ShiprocketService.parsePickupDateFromScheduleResponse(data, null);
      return {
        success: true,
        pickupDate: confirmedDate,
        providerStatus: data.pickup_status || data.status || 'pickup_scheduled',
        raw: data,
        mock: false
      };
    } catch (err) {
      logger.error('[Shiprocket] retryPickup failed:', err.response?.data || err.message);
      return {
        success: false,
        code: 'PICKUP_RETRY_FAILED',
        message: ShiprocketService.formatAxiosError(err),
        details: err.response?.data || null
      };
    }
  }

  /**
   * GET /external/orders/show/{id} — full forward-order snapshot for DB sync.
   * @returns {Promise<{ success: boolean, snapshot?: object, code?: string, message?: string }>}
   */
  async fetchForwardOrderSnapshot({ shiprocketOrderId, channelOrderId }) {
    if (!this.enabled) {
      return { success: false, code: 'SHIPROCKET_DISABLED', message: 'Shiprocket is disabled' };
    }
    const rawIds = [shiprocketOrderId, channelOrderId]
      .map((x) => (x != null ? String(x).trim() : ''))
      .filter(Boolean);
    const ids = [...new Set(rawIds)];
    for (const id of ids) {
      try {
        const data = await this.requestWithAuth({
          method: 'get',
          url: `${this.baseURL}/external/orders/show/${encodeURIComponent(id)}`,
          timeout: 20000
        });
        if (!data) continue;
        const root = ShiprocketService.normalizeForwardOrderRoot(data);
        const snapshot = ShiprocketService.extractForwardOrderSnapshot(root);
        if (!snapshot) continue;
        if (snapshot.shiprocketOrderId || snapshot.shipmentId) {
          return { success: true, snapshot, raw: root };
        }
      } catch (err) {
        logger.warn('[Shiprocket] fetchForwardOrderSnapshot show failed', {
          id,
          status: err.response?.status,
          message: err?.message
        });
      }
    }
    return {
      success: false,
      code: 'FORWARD_ORDER_LOOKUP_FAILED',
      message:
        'Could not load order details from Shiprocket. Confirm the order exists and retry after AWB assignment.'
    };
  }

  /** True when URL is Shiprocket tax invoice, not courier shipping label. */
  static isLikelyTaxInvoiceUrl(url) {
    const u = String(url || '').toLowerCase();
    if (!u.startsWith('http')) return false;
    return (
      /\/invoice|invoice\.pdf|print\/invoice|tax[-_]?invoice|gst[-_]?invoice/.test(u) ||
      (u.includes('invoice') && !u.includes('label'))
    );
  }

  static extractShippingLabelUrl(data) {
    if (!data) return null;
    if (typeof data === 'string' && /^https?:\/\//i.test(data)) {
      const s = data.trim();
      return ShiprocketService.isLikelyTaxInvoiceUrl(s) ? null : s;
    }
    if (Array.isArray(data)) {
      for (const row of data) {
        const u = ShiprocketService.extractShippingLabelUrl(row);
        if (u) return u;
      }
      return null;
    }
    if (typeof data !== 'object') return null;

    const direct =
      data.label_url ||
      data.labelUrl ||
      data.shipping_label_url ||
      data.shipping_label ||
      data.awb_label_url ||
      (Array.isArray(data.label_url) ? data.label_url[0] : null) ||
      (Array.isArray(data.data) && typeof data.data[0] === 'string' ? data.data[0] : null) ||
      (data.data && typeof data.data === 'object'
        ? data.data.label_url || data.data.shipping_label_url
        : null);
    if (direct && String(direct).trim() && !ShiprocketService.isLikelyTaxInvoiceUrl(direct)) {
      return String(direct).trim();
    }

    if (data.response) return ShiprocketService.extractShippingLabelUrl(data.response);
    if (data.data) return ShiprocketService.extractShippingLabelUrl(data.data);
    if (Array.isArray(data.labels)) {
      for (const row of data.labels) {
        const u = ShiprocketService.extractShippingLabelUrl(row);
        if (u) return u;
      }
    }
    return null;
  }

  /**
   * POST /external/courier/generate/label — courier shipping label (AWB sticker), NOT tax invoice.
   * Tax invoice is our GST HTML / Shiprocket print/invoice — separate from this.
   */
  async generateShippingLabel({ shiprocketOrderId, channelOrderId, shipmentId } = {}) {
    let sid = this.parseNumericShipmentId(shipmentId);
    let resolvedOrderId = this.parseNumericShiprocketOrderId(shiprocketOrderId);

    if (!sid || !resolvedOrderId) {
      const lookup = await this.fetchForwardOrderSnapshot({ shiprocketOrderId, channelOrderId });
      if (lookup.success && lookup.snapshot) {
        if (!sid) sid = this.parseNumericShipmentId(lookup.snapshot.shipmentId);
        if (!resolvedOrderId) {
          resolvedOrderId = this.parseNumericShiprocketOrderId(lookup.snapshot.shiprocketOrderId);
        }
        const snapLabel = lookup.snapshot.labelUrl;
        if (snapLabel && !ShiprocketService.isLikelyTaxInvoiceUrl(snapLabel)) {
          return {
            success: true,
            labelUrl: snapLabel,
            shiprocketOrderId: lookup.snapshot.shiprocketOrderId || null,
            shipmentId: sid ? String(sid) : null,
            raw: lookup.raw,
            mock: false,
            source: 'order_snapshot'
          };
        }
      }
    }

    if (!sid) {
      return {
        success: false,
        code: 'SHIPMENT_ID_REQUIRED',
        message:
          'shipment_id is required to generate a courier shipping label. Assign AWB (Ship now) first.'
      };
    }

    if (!this.enabled) {
      return {
        success: true,
        mock: true,
        labelUrl: `https://example.invalid/mock-shipping-label-${sid}.pdf`,
        shiprocketOrderId: resolvedOrderId != null ? String(resolvedOrderId) : null,
        shipmentId: String(sid),
        raw: { mock: true }
      };
    }

    try {
      const data = await this.requestWithAuth({
        method: 'post',
        url: `${this.baseURL}/external/courier/generate/label`,
        data: { shipment_id: [sid] },
        timeout: 45000
      });
      if (!data) {
        return { success: false, code: 'SHIPROCKET_AUTH_FAILED', message: 'Shiprocket auth failed' };
      }
      const labelUrl = ShiprocketService.extractShippingLabelUrl(data);
      if (!labelUrl) {
        return {
          success: false,
          code: 'LABEL_URL_MISSING',
          message:
            'Shiprocket did not return a shipping label URL. Generate manifest on Shiprocket if required, then retry.',
          details: data
        };
      }
      return {
        success: true,
        labelUrl,
        shiprocketOrderId: resolvedOrderId != null ? String(resolvedOrderId) : null,
        shipmentId: String(sid),
        raw: data,
        mock: false,
        source: 'generate_label'
      };
    } catch (err) {
      logger.error('[Shiprocket] generateShippingLabel failed:', err.response?.data || err.message);
      return {
        success: false,
        code: 'LABEL_GENERATE_FAILED',
        message: ShiprocketService.formatAxiosError(err),
        details: err.response?.data || null
      };
    }
  }

  /** Normalize pickup-list lookup refs (shipment id, Shiprocket order id, channel order id). */
  static normalizePickupListRefs(refs) {
    if (refs == null) return {};
    if (typeof refs === 'number' || (typeof refs === 'string' && /^\d+$/.test(String(refs).trim()))) {
      return { shipmentId: refs };
    }
    return refs;
  }

  /** Collect shipment / order / channel ids on a pickup-list node (panel often lists order ids). */
  static collectReferenceIdsFromNode(node) {
    const shipmentIds = new Set();
    const orderIds = new Set();
    const channelIds = new Set();
    if (!node || typeof node !== 'object') {
      return { shipmentIds, orderIds, channelIds };
    }

    const addShip = (value) => {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) shipmentIds.add(n);
    };
    const addOrder = (value) => {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) orderIds.add(n);
    };
    const addChannel = (value) => {
      if (value == null) return;
      const s = String(value).trim();
      if (s) channelIds.add(s);
    };

    addShip(node.shipment_id);
    addShip(node.shipmentId);
    addOrder(node.id);
    addOrder(node.order_id);
    addOrder(node.shiprocket_order_id);
    addChannel(node.channel_order_id);

    for (const key of [
      'shipments',
      'shipment_ids',
      'shipmentIds',
      'shipment_data',
      'orders',
      'order_ids',
      'orderIds',
      'data'
    ]) {
      const arr = node[key];
      if (!Array.isArray(arr)) continue;
      for (const item of arr) {
        if (item == null) continue;
        if (typeof item === 'object') {
          addShip(item.shipment_id ?? item.shipmentId);
          addOrder(item.id ?? item.order_id ?? item.shiprocket_order_id);
          addChannel(item.channel_order_id);
        } else {
          addShip(item);
          addOrder(item);
        }
      }
    }
    return { shipmentIds, orderIds, channelIds };
  }

  /** @deprecated use collectReferenceIdsFromNode */
  static collectShipmentIdsFromNode(node) {
    return ShiprocketService.collectReferenceIdsFromNode(node).shipmentIds;
  }

  static nodeMatchesPickupRefs(node, refs) {
    const { shipmentIds, orderIds, channelIds } = ShiprocketService.collectReferenceIdsFromNode(node);
    const sid = Number(refs.shipmentId);
    const oid = Number(refs.shiprocketOrderId);
    const cid = refs.channelOrderId != null ? String(refs.channelOrderId).trim() : '';
    if (Number.isFinite(sid) && sid > 0 && shipmentIds.has(sid)) return true;
    if (Number.isFinite(oid) && oid > 0 && orderIds.has(oid)) return true;
    if (cid && channelIds.has(cid)) return true;
    return false;
  }

  static extractScheduledDateFromPickupBatchNode(node) {
    if (!node || typeof node !== 'object') return null;
    const fieldCandidates = [
      node.pickup_scheduled_date,
      node.pickup_schedule_date,
      node.scheduled_date
    ];
    for (const c of fieldCandidates) {
      const parsed = ShiprocketService.parseCourierPickupDateValue(c);
      if (parsed) return parsed;
    }
    const statusText = [
      node.pickup_status,
      node.pickup_status_text,
      node.pickup_status_label
    ]
      .filter(Boolean)
      .join(' ');
    const fromStatus = ShiprocketService.parsePickupDateFromHumanText(statusText);
    return fromStatus && ShiprocketService.isPlausibleCourierPickupYmd(fromStatus) ? fromStatus : null;
  }

  static scorePickupBatchNode(node) {
    const pickupIdStr = String(node?.pickup_id ?? node?.pickupId ?? '');
    let score = 0;
    if (/srpid/i.test(pickupIdStr)) score += 100;
    if (node?.pickup_scheduled_date) score += 20;
    if (/pickup\s*scheduled/i.test(String(node?.pickup_status || ''))) score += 10;
    return score;
  }

  /**
   * Match panel "Pickups & Manifests" list — pickup batch (SRPID-…) contains many shipments.
   * Returns the batch scheduled date ("For 18 May 2026"), not admin-selected dates.
   */
  static findPickupDateInPickupListPayload(data, refs) {
    const r = ShiprocketService.normalizePickupListRefs(refs);
    const sid = Number(r.shipmentId);
    const oid = Number(r.shiprocketOrderId);
    const cid = r.channelOrderId != null ? String(r.channelOrderId).trim() : '';
    const hasRef =
      (Number.isFinite(sid) && sid > 0) ||
      (Number.isFinite(oid) && oid > 0) ||
      Boolean(cid);
    if (!hasRef) return null;

    let best = null;
    const queue = [data];
    const seen = new Set();
    while (queue.length) {
      const node = queue.shift();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      if (Array.isArray(node)) {
        for (const item of node) queue.push(item);
        continue;
      }

      const { shipmentIds, orderIds } = ShiprocketService.collectReferenceIdsFromNode(node);
      const pickupIdStr = String(node.pickup_id ?? node.pickupId ?? '');
      const looksLikePickupBatch =
        /srpid/i.test(pickupIdStr) ||
        node.pickup_id != null ||
        node.pickupId != null ||
        (node.pickup_status && (shipmentIds.size > 0 || orderIds.size > 0)) ||
        (node.pickup_scheduled_date && (shipmentIds.size > 0 || orderIds.size > 0));

      if (looksLikePickupBatch && ShiprocketService.nodeMatchesPickupRefs(node, r)) {
        const scheduled = ShiprocketService.extractScheduledDateFromPickupBatchNode(node);
        if (scheduled && ShiprocketService.isPlausibleCourierPickupYmd(scheduled)) {
          const score = ShiprocketService.scorePickupBatchNode(node);
          if (!best || score > best.score || (score === best.score && scheduled > best.ymd)) {
            best = { ymd: scheduled, score };
          }
        }
      }

      for (const v of Object.values(node)) {
        if (v && typeof v === 'object') queue.push(v);
      }
    }
    return best ? best.ymd : null;
  }

  async fetchPickupDateForShipment({ shipmentId, shiprocketOrderId, channelOrderId } = {}) {
    const sid = this.parseNumericShipmentId(shipmentId);
    const oid = this.parseNumericShiprocketOrderId(shiprocketOrderId);
    const cid = channelOrderId != null ? String(channelOrderId).trim() : '';
    if (!sid && !oid && !cid) {
      return { success: false, code: 'INVALID_REF', message: 'shipment_id or order id required' };
    }
    if (!this.enabled) {
      return { success: false, code: 'SHIPROCKET_DISABLED', message: 'Shiprocket is disabled' };
    }

    const refs = { shipmentId: sid, shiprocketOrderId: oid, channelOrderId: cid };
    const baseAttempts = [
      { path: '/external/pickup/pickupids', params: { per_page: 100 } },
      { path: '/external/pickup', params: { per_page: 100 } }
    ];
    if (sid) {
      baseAttempts.unshift(
        { path: '/external/pickup/pickupids', params: { shipment_id: sid, per_page: 100 } },
        { path: '/external/pickup/pickupids', params: { shipment_ids: [sid], per_page: 100 } }
      );
    }
    if (oid) {
      baseAttempts.unshift({
        path: '/external/pickup/pickupids',
        params: { order_id: oid, per_page: 100 }
      });
    }

    for (const { path, params: baseParams } of baseAttempts) {
      for (let page = 1; page <= 5; page += 1) {
        try {
          const data = await this.requestWithAuth({
            method: 'get',
            url: `${this.baseURL}${path}`,
            params: { ...baseParams, page },
            timeout: 25000
          });
          const pickupDate = ShiprocketService.findPickupDateInPickupListPayload(data, refs);
          if (
            pickupDate &&
            ShiprocketService.isPlausibleCourierPickupYmd(pickupDate)
          ) {
            return { success: true, pickupDate, source: path, raw: data };
          }
          const rows = Array.isArray(data?.data)
            ? data.data
            : Array.isArray(data)
              ? data
              : [];
          if (rows.length < (baseParams.per_page || 100)) break;
        } catch (err) {
          logger.warn('[Shiprocket] fetchPickupDateForShipment failed', {
            path,
            page,
            shipmentId: sid,
            shiprocketOrderId: oid,
            status: err.response?.status,
            message: err?.message
          });
          break;
        }
      }
    }
    return {
      success: false,
      code: 'PICKUP_DATE_NOT_IN_LIST',
      message: 'Pickup date not found in Shiprocket pickup list'
    };
  }

  /**
   * Authoritative courier pickup day — Shiprocket panel is source of truth (never admin UI date).
   * Priority: GET orders/show (pickup_scheduled_date) → pickup list API when available.
   */
  async resolveAuthoritativePickupDate({
    shipmentId,
    shiprocketOrderId,
    channelOrderId,
    allowPickupListFallback = true
  } = {}) {
    let sid = this.parseNumericShipmentId(shipmentId);
    const oid = this.parseNumericShiprocketOrderId(shiprocketOrderId);
    const cid = channelOrderId != null ? String(channelOrderId).trim() : '';

    const lookup = await this.fetchForwardOrderSnapshot({ shiprocketOrderId, channelOrderId });
    if (lookup.success && lookup.snapshot) {
      if (!sid && lookup.snapshot.shipmentId) {
        sid = this.parseNumericShipmentId(lookup.snapshot.shipmentId);
      }
      const fromShow =
        lookup.snapshot.pickupDate ||
        (lookup.raw
          ? ShiprocketService.extractStrictPickupScheduledDateFromOrderShow(lookup.raw)
          : null);
      if (fromShow && ShiprocketService.isPlausibleCourierPickupYmd(fromShow)) {
        return { success: true, pickupDate: fromShow, source: 'orders_show', shipmentId: sid };
      }
      if (lookup.snapshot.pickupScheduled === false || allowPickupListFallback === false) {
        return {
          success: false,
          pickupDate: null,
          source: 'orders_show_no_pickup',
          shipmentId: sid
        };
      }
    }

    const listRes = await this.fetchPickupDateForShipment({
      shipmentId: sid,
      shiprocketOrderId:
        oid ||
        (lookup.success
          ? this.parseNumericShiprocketOrderId(lookup.snapshot?.shiprocketOrderId)
          : null),
      channelOrderId: cid
    });
    if (listRes.success && listRes.pickupDate) {
      return {
        success: true,
        pickupDate: listRes.pickupDate,
        source: 'pickup_list',
        shipmentId: sid
      };
    }

    return { success: false, pickupDate: null, source: 'none', shipmentId: sid };
  }

  isPickupAlreadyScheduledMessage(message) {
    return ShiprocketService.isPickupAlreadyScheduledMessage(message);
  }

  parsePickupDateFromScheduleResponse(raw, fallbackYmd) {
    return ShiprocketService.parsePickupDateFromScheduleResponse(raw, fallbackYmd);
  }

  isLikelyTaxInvoiceUrl(url) {
    return ShiprocketService.isLikelyTaxInvoiceUrl(url);
  }

  normalizeYmdDate(value) {
    return ShiprocketService.normalizeYmdDate(value);
  }

  isPlausibleCourierPickupYmd(ymd, opts) {
    return ShiprocketService.isPlausibleCourierPickupYmd(ymd, opts);
  }

  parseCourierPickupDateValue(value) {
    return ShiprocketService.parseCourierPickupDateValue(value);
  }

  parsePickupDateFromHumanText(value) {
    return ShiprocketService.parsePickupDateFromHumanText(value);
  }

  /**
   * When we stored Shiprocket order id but not shipment_id, resolve shipment_id via orders/show.
   */
  async fetchShipmentIdForForwardOrder({ shiprocketOrderId, channelOrderId }) {
    if (!this.enabled) {
      return { success: false, code: 'SHIPROCKET_DISABLED', message: 'Shiprocket is disabled' };
    }
    const lookup = await this.fetchForwardOrderSnapshot({ shiprocketOrderId, channelOrderId });
    if (lookup.success && lookup.snapshot?.shipmentId) {
      return {
        success: true,
        shipmentId: lookup.snapshot.shipmentId,
        shiprocketOrderId: lookup.snapshot.shiprocketOrderId || null,
        raw: lookup.raw
      };
    }
    return {
      success: false,
      code: 'SHIPMENT_ID_LOOKUP_FAILED',
      message:
        lookup.message ||
        'Could not read shipment_id from Shiprocket. If the order is waiting for courier selection on Shiprocket, finish that there or retry after saving.'
    };
  }

  /**
   * Load pickup locations / schedule rules from Shiprocket (panel preferences).
   * Tries documented external settings paths until one succeeds.
   */
  async fetchPickupLocationsRaw() {
    if (!this.enabled) {
      return { success: false, code: 'SHIPROCKET_DISABLED', message: 'Shiprocket is disabled' };
    }
    const nickname = this.getConfiguredPickupLocationNickname();
    const paths = [
      '/external/settings/company/pickup',
      '/external/settings/company/pickupaddress',
      '/external/settings/company/pickup-address',
      '/external/settings/company/getpickup'
    ];

    let best = null;
    let bestScore = -1;

    for (const path of paths) {
      try {
        const data = await this.requestWithAuth({
          method: 'get',
          url: `${this.baseURL}${path}`,
          timeout: 20000
        });
        if (!data) continue;

        const parsed = pickupCalendarUtil.parsePickupPreferencesFromPayload(data, {
          pickupLocationNickname: nickname
        });
        const score =
          (parsed.hasScheduleRules ? 100 : 0) +
          (parsed.locationRecordFound ? 20 : 0) +
          parsed.blockedWeekdays.length * 2 +
          parsed.holidays.length;

        if (score > bestScore) {
          bestScore = score;
          best = { raw: data, path, parsed };
        }
      } catch (err) {
        logger.warn('[Shiprocket] fetchPickupLocationsRaw failed', {
          path,
          status: err.response?.status,
          message: err?.message
        });
      }
    }

    if (best) {
      return { success: true, raw: best.raw, path: best.path, parsed: best.parsed };
    }

    return {
      success: false,
      code: 'PICKUP_SETTINGS_UNAVAILABLE',
      message: 'Could not load pickup schedule settings from Shiprocket.'
    };
  }

  /**
   * Pickup days off / holidays as configured in Shiprocket panel (cached 1h).
   */
  async getPickupSchedulePreferences({ forceRefresh = false } = {}) {
    const now = Date.now();
    if (
      !forceRefresh &&
      this.pickupPreferencesCache.preferences &&
      now - this.pickupPreferencesCache.at < PICKUP_PREFS_CACHE_MS
    ) {
      return { success: true, preferences: this.pickupPreferencesCache.preferences };
    }

    const nickname = this.getConfiguredPickupLocationNickname();
    let preferences = {
      pickupLocationNickname: nickname || null,
      blockedWeekdays: [],
      holidays: [],
      hasScheduleRules: false,
      source: 'none',
      locationRecordFound: false
    };

    if (this.enabled) {
      const api = await this.fetchPickupLocationsRaw();
      if (api.success) {
        const parsed =
          api.parsed ||
          pickupCalendarUtil.parsePickupPreferencesFromPayload(api.raw, {
            pickupLocationNickname: nickname
          });
        preferences = { ...preferences, ...parsed, apiPath: api.path };
      }
    }

    if (this.enabled && !preferences.hasScheduleRules) {
      logger.warn(
        '[Shiprocket] Pickup schedule fields were not found in API responses. ' +
          'Only preferences saved in the Shiprocket panel can drive closed days — verify pickup location settings in Shiprocket.'
      );
    }

    this.pickupPreferencesCache = { at: now, preferences };
    return { success: true, preferences };
  }

  /** Calendar of allowed pickup dates for admin date picker (from Shiprocket rules). */
  async getPickupCalendar({ daysAhead = 45, forceRefresh = false } = {}) {
    const prefsRes = await this.getPickupSchedulePreferences({ forceRefresh });
    const preferences = prefsRes.preferences || {
      blockedWeekdays: [],
      holidays: [],
      hasScheduleRules: false,
      source: 'none'
    };
    const calendar = pickupCalendarUtil.buildPickupCalendar(preferences, { daysAhead });
    return {
      success: true,
      preferences,
      calendar
    };
  }

  /** Validate admin-selected date against Shiprocket pickup rules. */
  async validatePickupDateForSchedule(pickupDateYmd) {
    const ymd = pickupCalendarUtil.normalizeYmd(pickupDateYmd);
    if (!ymd) {
      return { ok: false, code: 'INVALID_PICKUP_DATE', message: 'pickupDate must be YYYY-MM-DD' };
    }
    const prefsRes = await this.getPickupSchedulePreferences();
    const preferences = prefsRes.preferences;
    if (!preferences?.hasScheduleRules) {
      return { ok: true, date: ymd, preferences };
    }
    const check = pickupCalendarUtil.isPickupDateAllowed(preferences, ymd);
    if (!check.allowed) {
      return {
        ok: false,
        code: 'PICKUP_DATE_NOT_ALLOWED',
        message: check.reason || 'This pickup date is not available in your Shiprocket settings.',
        date: ymd,
        preferences
      };
    }
    return { ok: true, date: ymd, preferences };
  }

  static extractManifestUrl(data) {
    if (!data) return null;
    if (typeof data === 'string' && /^https?:\/\//i.test(data)) return data.trim();
    if (Array.isArray(data)) {
      for (const row of data) {
        const u = ShiprocketService.extractManifestUrl(row);
        if (u) return u;
      }
      return null;
    }
    if (typeof data !== 'object') return null;
    const direct =
      data.url ||
      data.manifest_url ||
      data.manifestUrl ||
      (Array.isArray(data.data) && typeof data.data[0] === 'string' ? data.data[0] : null) ||
      (data.data && typeof data.data === 'object' ? data.data.url || data.data.manifest_url : null);
    if (direct && String(direct).trim()) return String(direct).trim();
    if (data.response) return ShiprocketService.extractManifestUrl(data.response);
    if (data.data) return ShiprocketService.extractManifestUrl(data.data);
    return null;
  }

  /**
   * POST /external/manifests/generate — create manifest for shipment(s).
   */
  async generateManifest({ shipmentId }) {
    const sid = this.parseNumericShipmentId(shipmentId);
    if (!sid) {
      return { success: false, code: 'INVALID_SHIPMENT_ID', message: 'Valid shipment_id is required' };
    }
    if (!this.enabled) {
      return {
        success: true,
        mock: true,
        manifestUrl: `https://example.invalid/mock-manifest-${sid}.pdf`,
        raw: { mock: true }
      };
    }
    try {
      const data = await this.requestWithAuth({
        method: 'post',
        url: `${this.baseURL}/external/manifests/generate`,
        data: { shipment_id: [sid] },
        timeout: 45000
      });
      if (!data) {
        return { success: false, code: 'SHIPROCKET_AUTH_FAILED', message: 'Shiprocket auth failed' };
      }
      const manifestUrl = ShiprocketService.extractManifestUrl(data);
      return {
        success: true,
        manifestUrl,
        raw: data,
        mock: false
      };
    } catch (err) {
      logger.error('[Shiprocket] generateManifest failed:', err.response?.data || err.message);
      return {
        success: false,
        code: 'MANIFEST_GENERATE_FAILED',
        message: ShiprocketService.formatAxiosError(err),
        details: err.response?.data || null
      };
    }
  }

  /**
   * POST /external/orders/print/manifest — print manifest PDF URL (after generate).
   */
  async printManifest({ shiprocketOrderId, channelOrderId }) {
    let numericOrderId = this.parseNumericShiprocketOrderId(shiprocketOrderId);
    if (!numericOrderId && (channelOrderId || shiprocketOrderId)) {
      const lookup = await this.fetchForwardOrderSnapshot({ shiprocketOrderId, channelOrderId });
      if (lookup.success && lookup.snapshot?.shiprocketOrderId) {
        numericOrderId = this.parseNumericShiprocketOrderId(lookup.snapshot.shiprocketOrderId);
      }
    }
    if (!numericOrderId) {
      return {
        success: false,
        code: 'SHIPROCKET_ORDER_ID_REQUIRED',
        message: 'Shiprocket order id is required to print a manifest.'
      };
    }
    if (!this.enabled) {
      return {
        success: true,
        mock: true,
        manifestUrl: `https://example.invalid/mock-manifest-order-${numericOrderId}.pdf`,
        raw: { mock: true }
      };
    }
    try {
      const data = await this.requestWithAuth({
        method: 'post',
        url: `${this.baseURL}/external/orders/print/manifest`,
        data: { order_ids: [numericOrderId] },
        timeout: 45000
      });
      if (!data) {
        return { success: false, code: 'SHIPROCKET_AUTH_FAILED', message: 'Shiprocket auth failed' };
      }
      const manifestUrl = ShiprocketService.extractManifestUrl(data);
      return {
        success: true,
        manifestUrl,
        shiprocketOrderId: String(numericOrderId),
        raw: data,
        mock: false
      };
    } catch (err) {
      logger.error('[Shiprocket] printManifest failed:', err.response?.data || err.message);
      return {
        success: false,
        code: 'MANIFEST_PRINT_FAILED',
        message: ShiprocketService.formatAxiosError(err),
        details: err.response?.data || null
      };
    }
  }

  /**
   * POST /external/orders/cancel — cancel before dispatch (Shiprocket-side).
   * @param {{ ids: (string|number)[] }} shiprocketIds — Shiprocket order ids (numeric) as returned by create/adhoc.
   */
  async cancelShiprocketOrders(shiprocketIds = []) {
    const ids = (Array.isArray(shiprocketIds) ? shiprocketIds : [])
      .map((x) => Number(String(x).trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (!ids.length) {
      return { success: false, code: 'SHIPROCKET_IDS_REQUIRED', message: 'At least one Shiprocket order id is required' };
    }
    if (!this.enabled) {
      return { success: true, mock: true, raw: { cancelled: ids } };
    }
    try {
      const data = await this.requestWithAuth({
        method: 'post',
        url: `${this.baseURL}/external/orders/cancel`,
        data: { ids },
        timeout: 30000
      });
      if (!data) {
        return { success: false, code: 'SHIPROCKET_AUTH_FAILED', message: 'Shiprocket auth failed' };
      }
      return { success: true, raw: data, mock: false };
    } catch (err) {
      logger.error('[Shiprocket] cancelShiprocketOrders failed:', err.response?.data || err.message);
      return {
        success: false,
        code: 'SHIPROCKET_CANCEL_FAILED',
        message: ShiprocketService.formatAxiosError(err),
        details: err.response?.data || null
      };
    }
  }
}

module.exports = new ShiprocketService();
