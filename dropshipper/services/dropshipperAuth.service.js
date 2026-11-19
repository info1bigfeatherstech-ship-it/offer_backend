'use strict';

const crypto = require('crypto');
const path = require('path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const Razorpay = require('razorpay');

const DropshipperSettings = require('../models/DropshipperSettings');
const DropshipperRegistrationRequest = require('../models/DropshipperRegistrationRequest');
const Dropshipper = require('../models/Dropshipper');
const { BLOCKING_ACCOUNT_STATUSES } = Dropshipper;
const { cloudinary } = require('../../config/cloudinary.config');
const redisManager = require('../../config/redis.config');
const tokenStore = require('../../config/tokenBlacklist');
const { generateOTP, deliverOtpFor, getOtpExpiryMs } = require('../../services/otp.service');
const logger = require('../../utils/logger');

const SUBSCRIPTION_YEARS = 1;
const DEFAULT_FEE_INR = 800;
const SETTINGS_KEY = 'default';
const OTP_COOLDOWN_MS = 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;
const BCRYPT_ROUNDS = 12;
const MAX_REFRESH_SESSIONS = 5;
const OPEN_REQUEST_STATUSES = ['pending_payment', 'pending_admin', 'pending_otp'];
const ACCESS_EXPIRES = () => process.env.ACCESS_TOKEN_EXPIRES || '15m';
const REFRESH_EXPIRES = () => process.env.REFRESH_TOKEN_EXPIRES || '7d';

function createError(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function isProduction() {
  const nodeEnv = String(process.env.NODE_ENV || '').toLowerCase();
  const appEnv = String(process.env.APP_ENV || '').toLowerCase();
  return nodeEnv === 'production' || appEnv === 'production';
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length < 10) return '';
  return digits.slice(-10);
}

function parseBool(value) {
  if (typeof value === 'boolean') return value;
  const s = String(value || '').trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

function hashString(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length === 0 || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function roundMoney(n) {
  return Math.round(Number(n) * 100) / 100;
}

function addYears(date, years) {
  const next = new Date(date.getTime());
  next.setFullYear(next.getFullYear() + years);
  return next;
}

function feeFromSettings(doc) {
  const n = Number(doc?.subscriptionAmountInr);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_FEE_INR;
  return roundMoney(n);
}

async function getSettingsDoc() {
  let doc = await DropshipperSettings.findOne({ key: SETTINGS_KEY });
  if (!doc) {
    try {
      doc = await DropshipperSettings.create({
        key: SETTINGS_KEY,
        subscriptionAmountInr: DEFAULT_FEE_INR,
        subscriptionYears: SUBSCRIPTION_YEARS,
        registrationOpen: true
      });
    } catch (err) {
      if (err?.code === 11000) {
        doc = await DropshipperSettings.findOne({ key: SETTINGS_KEY });
      } else {
        throw err;
      }
    }
  }
  if (doc && doc.subscriptionYears !== SUBSCRIPTION_YEARS) {
    doc.subscriptionYears = SUBSCRIPTION_YEARS;
    await doc.save();
  }
  return doc;
}

function serializeSettings(doc) {
  return {
    channel: 'dropship',
    subscriptionAmountInr: feeFromSettings(doc),
    subscriptionYears: SUBSCRIPTION_YEARS,
    registrationOpen: doc?.registrationOpen !== false,
    updatedAt: doc?.updatedAt || null
  };
}

function adminStatusFor(status) {
  if (status === 'rejected') return 'rejected';
  if (['pending_otp', 'active', 'expired', 'suspended'].includes(status)) return 'approved';
  return 'pending';
}

function nextStepFor(status) {
  if (status === 'pending_payment') return 'complete_payment';
  if (status === 'pending_admin') return 'admin_approval';
  if (status === 'rejected') return 'rejected';
  if (['pending_otp', 'active', 'expired', 'suspended'].includes(status)) return 'otp_and_password';
  return 'admin_approval';
}

function statusMessage(status) {
  if (status === 'pending_payment') return 'Complete the subscription payment to submit your application.';
  if (status === 'pending_admin') return 'Payment received. Your application is pending admin approval.';
  if (status === 'pending_otp') return 'Approved. Verify the OTP sent to your email and create a password.';
  if (status === 'rejected') return 'This application was rejected.';
  if (status === 'active') return 'Account is active. Please login.';
  if (status === 'expired') return 'Subscription expired. Login and renew to continue.';
  if (status === 'suspended') return 'This account is suspended.';
  return 'Application received.';
}

function serializePublicStatus(doc) {
  const payment = doc.payment || {};
  return {
    id: String(doc._id),
    fullName: doc.fullName,
    email: doc.email,
    phone: doc.phone,
    businessName: doc.businessName || '',
    amountDueInr: Number(doc.amountDueInr || 0),
    amountPaidInr: Number(doc.amountPaidInr || 0),
    payment: {
      status: payment.status || 'pending',
      ...(payment.razorpayOrderId ? { razorpayOrderId: payment.razorpayOrderId } : {}),
      ...(payment.razorpayPaymentId ? { razorpayPaymentId: payment.razorpayPaymentId } : {}),
      ...(payment.paidAt ? { paidAt: payment.paidAt } : {})
    },
    adminStatus: adminStatusFor(doc.status),
    adminDecisionNote: doc.adminDecisionNote || '',
    createdAt: doc.createdAt
  };
}

function subscriptionActive(doc) {
  if (!doc || doc.status !== 'active') return false;
  const exp = doc.subscriptionExpiresAt ? new Date(doc.subscriptionExpiresAt) : null;
  return Boolean(exp && exp.getTime() > Date.now());
}

function serializePublicAccount(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    fullName: doc.fullName,
    email: doc.email,
    phone: doc.phone,
    whatsappNumber: doc.whatsappNumber,
    businessName: doc.businessName || '',
    status: doc.status,
    subscriptionYears: SUBSCRIPTION_YEARS,
    subscriptionStartedAt: doc.subscriptionStartedAt || null,
    subscriptionExpiresAt: doc.subscriptionExpiresAt || null,
    subscriptionActive: subscriptionActive(doc)
  };
}

function serializeAdminAccount(doc) {
  if (!doc) return null;
  return {
    ...serializePublicAccount(doc),
    permanentAddress: doc.permanentAddress || '',
    haveShop: doc.haveShop === true,
    businessAddress: doc.businessAddress || '',
    deliveryAddress: doc.deliveryAddress || '',
    sellingPlaceFrom: doc.sellingPlaceFrom || '',
    sellingZoneCity: doc.sellingZoneCity || '',
    productCategory: doc.productCategory || '',
    monthlyEstimatedPurchase: doc.monthlyEstimatedPurchase,
    registrationRequestId: doc.registrationRequestId || null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt
  };
}

function serializeAdminRequest(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    fullName: doc.fullName,
    email: doc.email,
    phone: doc.phone,
    whatsappNumber: doc.whatsappNumber,
    businessName: doc.businessName || '',
    permanentAddress: doc.permanentAddress,
    haveShop: doc.haveShop === true,
    businessAddress: doc.businessAddress,
    deliveryAddress: doc.deliveryAddress,
    sellingPlaceFrom: doc.sellingPlaceFrom,
    sellingZoneCity: doc.sellingZoneCity,
    productCategory: doc.productCategory,
    monthlyEstimatedPurchase: doc.monthlyEstimatedPurchase,
    idProofUrl: doc.idProofUrl || '',
    businessAddressProofUrl: doc.businessAddressProofUrl || '',
    amountDueInr: Number(doc.amountDueInr || 0),
    amountPaidInr: Number(doc.amountPaidInr || 0),
    subscriptionYears: SUBSCRIPTION_YEARS,
    payment: doc.payment || { status: 'pending' },
    status: doc.status,
    adminStatus: adminStatusFor(doc.status),
    adminDecisionNote: doc.adminDecisionNote || '',
    reviewedBy: doc.reviewedBy || null,
    reviewedAt: doc.reviewedAt || null,
    dropshipperId: doc.dropshipperId || null,
    nextStep: nextStepFor(doc.status),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt
  };
}

function validateApplicant(body) {
  const fullName = String(body?.fullName || '').trim();
  const email = normalizeEmail(body?.email);
  const phone = normalizePhone(body?.phone);
  const whatsappNumber = normalizePhone(body?.whatsappNumber);
  const businessName = String(body?.businessName || '').trim();
  const permanentAddress = String(body?.permanentAddress || '').trim();
  const businessAddress = String(body?.businessAddress || '').trim();
  const deliveryAddress = String(body?.deliveryAddress || '').trim();
  const sellingPlaceFrom = String(body?.sellingPlaceFrom || '').trim();
  const sellingZoneCity = String(body?.sellingZoneCity || '').trim();
  const productCategory = String(body?.productCategory || '').trim();
  const purchaseRaw = String(body?.monthlyEstimatedPurchase ?? '').replace(/,/g, '').trim();
  const monthlyEstimatedPurchase = Number(purchaseRaw);

  if (fullName.length < 2) throw createError(400, 'VALIDATION_ERROR', 'Full name is required');
  if (!isValidEmail(email)) throw createError(400, 'VALIDATION_ERROR', 'A valid email is required');
  if (!/^\d{10}$/.test(phone)) {
    throw createError(400, 'VALIDATION_ERROR', 'Mobile must be a 10-digit Indian number');
  }
  if (!/^\d{10}$/.test(whatsappNumber)) {
    throw createError(400, 'VALIDATION_ERROR', 'WhatsApp must be a 10-digit Indian number');
  }
  if (permanentAddress.length < 5) {
    throw createError(400, 'VALIDATION_ERROR', 'Permanent address is required');
  }
  if (businessAddress.length < 5) {
    throw createError(400, 'VALIDATION_ERROR', 'Business address is required');
  }
  if (deliveryAddress.length < 5) {
    throw createError(400, 'VALIDATION_ERROR', 'Delivery address is required');
  }
  if (sellingPlaceFrom.length < 2) {
    throw createError(400, 'VALIDATION_ERROR', 'Selling place is required');
  }
  if (sellingZoneCity.length < 2) {
    throw createError(400, 'VALIDATION_ERROR', 'Selling zone / city is required');
  }
  if (productCategory.length < 2) {
    throw createError(400, 'VALIDATION_ERROR', 'Product category is required');
  }
  if (!Number.isFinite(monthlyEstimatedPurchase) || monthlyEstimatedPurchase < 0) {
    throw createError(400, 'VALIDATION_ERROR', 'Monthly estimated purchase must be a valid amount');
  }

  return {
    fullName: fullName.slice(0, 120),
    email,
    phone,
    whatsappNumber,
    businessName: businessName.slice(0, 160),
    permanentAddress: permanentAddress.slice(0, 500),
    haveShop: parseBool(body?.haveShop),
    businessAddress: businessAddress.slice(0, 500),
    deliveryAddress: deliveryAddress.slice(0, 500),
    sellingPlaceFrom: sellingPlaceFrom.slice(0, 160),
    sellingZoneCity: sellingZoneCity.slice(0, 160),
    productCategory: productCategory.slice(0, 160),
    monthlyEstimatedPurchase
  };
}

async function findOpenRequests(email, phone) {
  return DropshipperRegistrationRequest.find({
    status: { $in: OPEN_REQUEST_STATUSES },
    $or: [{ email }, { phone }]
  }).sort({ updatedAt: -1 });
}

async function findBlockingAccounts(email, phone) {
  return Dropshipper.find({
    status: { $in: BLOCKING_ACCOUNT_STATUSES },
    $or: [{ email }, { phone }]
  });
}

function assertNoIdentityConflict(rows, email, phone) {
  const emailHit = rows.find((row) => row.email === email);
  const phoneHit = rows.find((row) => row.phone === phone);
  if (emailHit && phoneHit && String(emailHit._id) !== String(phoneHit._id)) {
    throw createError(
      409,
      'IDENTITY_CONFLICT',
      'This email and phone are linked to different applications. Contact support.'
    );
  }
  return emailHit || phoneHit || null;
}

async function assertCanRegister(applicant) {
  const accounts = await findBlockingAccounts(applicant.email, applicant.phone);
  const blocking = assertNoIdentityConflict(accounts, applicant.email, applicant.phone);
  if (blocking) {
    if (blocking.status === 'suspended') {
      throw createError(403, 'ACCOUNT_SUSPENDED', 'This account is suspended.');
    }
    if (blocking.status === 'pending_otp') {
      throw createError(
        409,
        'AWAITING_ACTIVATION',
        'Your application is approved. Activate with OTP instead of registering again.'
      );
    }
    throw createError(
      409,
      'ACCOUNT_ALREADY_EXISTS',
      'A dropshipper account already exists for this email or phone. Please login.'
    );
  }

  const requests = await findOpenRequests(applicant.email, applicant.phone);
  const open = assertNoIdentityConflict(requests, applicant.email, applicant.phone);
  if (open && open.status === 'pending_admin') {
    throw createError(
      409,
      'APPLICATION_PENDING',
      'Your application is already pending admin approval.'
    );
  }
  if (open && open.status === 'pending_otp') {
    throw createError(
      409,
      'AWAITING_ACTIVATION',
      'Your application is approved. Activate with OTP instead of registering again.'
    );
  }
  return open && open.status === 'pending_payment' ? open : null;
}

function pickProofFile(files, names) {
  const bag = files || {};
  for (const name of names) {
    if (Array.isArray(bag[name]) && bag[name][0]) return bag[name][0];
  }
  return null;
}

function sanitizePublicId(value) {
  return (
    String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || 'proof'
  );
}

function uploadBufferToCloudinary(file, folder, publicIdPrefix) {
  return new Promise((resolve, reject) => {
    if (!file?.buffer || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
      reject(createError(400, 'PROOF_REQUIRED', 'Proof file is empty'));
      return;
    }
    const ext = path.extname(String(file.originalname || '')).toLowerCase();
    const isPdf = file.mimetype === 'application/pdf' || ext === '.pdf';
    const options = {
      folder,
      resource_type: isPdf ? 'raw' : 'image',
      public_id: `${publicIdPrefix}-${Date.now()}`
    };
    if (isPdf) options.format = 'pdf';

    const stream = cloudinary.uploader.upload_stream(options, (error, result) => {
      if (error || !result?.secure_url) {
        logger.error('[dropshipperAuth] Cloudinary proof upload failed', {
          message: error?.message || 'empty result'
        });
        reject(createError(502, 'PROOF_UPLOAD_FAILED', 'Could not store proof documents. Please try again.'));
        return;
      }
      resolve({
        url: result.secure_url,
        publicId: result.public_id
      });
    });
    stream.end(file.buffer);
  });
}

function assertCloudinaryConfigured() {
  const ok =
    String(process.env.CLOUDINARY_CLOUD_NAME || '').trim() &&
    String(process.env.CLOUDINARY_API_KEY || '').trim() &&
    String(process.env.CLOUDINARY_API_SECRET || '').trim();
  if (!ok) {
    throw createError(503, 'PROOF_STORAGE_UNAVAILABLE', 'Document upload is temporarily unavailable.');
  }
}

async function uploadRegistrationProofs(files, fullName) {
  assertCloudinaryConfigured();
  const idFile = pickProofFile(files, ['idProof', 'idProofUpload', 'idProofFile']);
  const businessFile = pickProofFile(files, [
    'businessAddressProof',
    'businessAddressProofUpload',
    'businessAddressProofFile'
  ]);
  if (!idFile) throw createError(400, 'PROOF_REQUIRED', 'ID proof is required');
  if (!businessFile) throw createError(400, 'PROOF_REQUIRED', 'Business address proof is required');

  const prefix = sanitizePublicId(fullName);
  const [idProof, businessProof] = await Promise.all([
    uploadBufferToCloudinary(idFile, 'dropshipper/proofs/id', `${prefix}-id`),
    uploadBufferToCloudinary(businessFile, 'dropshipper/proofs/business', `${prefix}-business`)
  ]);
  return { idProof, businessProof };
}

function getRazorpayClient() {
  const key_id = String(process.env.RAZORPAY_KEY_ID || '').trim();
  const key_secret = String(process.env.RAZORPAY_KEY_SECRET || '').trim();
  if (!key_id || !key_secret) {
    throw createError(503, 'RAZORPAY_NOT_CONFIGURED', 'Payment is temporarily unavailable.');
  }
  return {
    keyId: key_id,
    client: new Razorpay({ key_id, key_secret })
  };
}

function assertPaymentSignature(orderId, paymentId, signature) {
  const secret = String(process.env.RAZORPAY_KEY_SECRET || '').trim();
  if (!secret) {
    throw createError(503, 'RAZORPAY_NOT_CONFIGURED', 'Payment verification is temporarily unavailable.');
  }
  const expected = crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
  if (!safeEqual(expected, signature)) {
    throw createError(400, 'PAYMENT_SIGNATURE_INVALID', 'Payment signature verification failed.');
  }
}

async function assertCapturedRazorpayPayment(client, { orderId, paymentId, expectedPaise }) {
  let payment;
  let order;
  try {
    [payment, order] = await Promise.all([
      client.payments.fetch(paymentId),
      client.orders.fetch(orderId)
    ]);
  } catch (err) {
    logger.error('[dropshipperAuth] Razorpay fetch failed', { message: err?.message });
    throw createError(502, 'PAYMENT_VERIFY_FAILED', 'Could not confirm payment with the gateway.');
  }

  const paymentStatus = String(payment?.status || '').toLowerCase();
  if (!['authorized', 'captured'].includes(paymentStatus)) {
    throw createError(409, 'PAYMENT_NOT_CAPTURED', 'Payment is not completed yet.');
  }
  if (String(payment.order_id || '') !== orderId) {
    throw createError(409, 'PAYMENT_ORDER_MISMATCH', 'Payment does not belong to this order.');
  }
  if (Number(order?.amount) !== expectedPaise || Number(payment?.amount) !== expectedPaise) {
    throw createError(409, 'PAYMENT_AMOUNT_MISMATCH', 'Payment amount does not match the subscription fee.');
  }
  return { payment, order };
}

function applyApplicant(doc, applicant) {
  doc.fullName = applicant.fullName;
  doc.email = applicant.email;
  doc.phone = applicant.phone;
  doc.whatsappNumber = applicant.whatsappNumber;
  doc.businessName = applicant.businessName;
  doc.permanentAddress = applicant.permanentAddress;
  doc.haveShop = applicant.haveShop;
  doc.businessAddress = applicant.businessAddress;
  doc.deliveryAddress = applicant.deliveryAddress;
  doc.sellingPlaceFrom = applicant.sellingPlaceFrom;
  doc.sellingZoneCity = applicant.sellingZoneCity;
  doc.productCategory = applicant.productCategory;
  doc.monthlyEstimatedPurchase = applicant.monthlyEstimatedPurchase;
}

async function getSubscriptionSettings() {
  const doc = await getSettingsDoc();
  return { success: true, settings: serializeSettings(doc) };
}

async function startRegistration(body) {
  const settings = await getSettingsDoc();
  if (settings.registrationOpen === false) {
    throw createError(403, 'REGISTRATION_CLOSED', 'Registration is temporarily closed');
  }
  const applicant = validateApplicant(body);
  await assertCanRegister(applicant);
  const fee = feeFromSettings(settings);
  return {
    success: true,
    message: 'Application looks valid. Continue to payment.',
    preview: {
      amountDueInr: fee,
      subscriptionAmountInr: fee,
      subscriptionYears: SUBSCRIPTION_YEARS,
      currency: 'INR',
      registrationOpen: true
    },
    applicant: {
      fullName: applicant.fullName,
      email: applicant.email,
      phone: applicant.phone
    }
  };
}

async function createRegistrationPayment({ body, files }) {
  const settings = await getSettingsDoc();
  if (settings.registrationOpen === false) {
    throw createError(403, 'REGISTRATION_CLOSED', 'Registration is temporarily closed');
  }
  const applicant = validateApplicant(body);
  const existing = await assertCanRegister(applicant);
  const proofs = await uploadRegistrationProofs(files, applicant.fullName);
  const fee = feeFromSettings(settings);
  const amountPaise = Math.round(fee * 100);

  const doc = existing || new DropshipperRegistrationRequest();
  applyApplicant(doc, applicant);
  doc.amountDueInr = fee;
  doc.amountPaidInr = 0;
  doc.subscriptionYears = SUBSCRIPTION_YEARS;
  doc.status = 'pending_payment';
  doc.idProofUrl = proofs.idProof.url;
  doc.idProofPublicId = proofs.idProof.publicId;
  doc.businessAddressProofUrl = proofs.businessProof.url;
  doc.businessAddressProofPublicId = proofs.businessProof.publicId;
  doc.payment = {
    status: 'pending',
    razorpayOrderId: null,
    razorpayPaymentId: null,
    paidAt: null
  };
  await doc.save();

  const { client, keyId } = getRazorpayClient();
  let order;
  try {
    order = await client.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: `dsreg-${String(doc._id).slice(-12)}-${Date.now().toString(36)}`.slice(0, 40),
      payment_capture: 1,
      notes: {
        type: 'dropshipper_registration',
        requestId: String(doc._id),
        email: doc.email
      }
    });
  } catch (err) {
    logger.error('[dropshipperAuth] Razorpay registration order failed', { message: err?.message });
    throw createError(503, 'RAZORPAY_ORDER_FAILED', 'Could not start payment. Please try again.');
  }

  doc.payment.razorpayOrderId = order.id;
  doc.markModified('payment');
  await doc.save();

  return {
    success: true,
    message: 'Complete payment to submit your application.',
    requestId: String(doc._id),
    request: { id: String(doc._id) },
    amountInr: fee,
    subscriptionYears: SUBSCRIPTION_YEARS,
    razorpay: {
      keyId,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency || 'INR'
    }
  };
}

async function verifyRegistrationPayment(body) {
  const requestId = String(body?.requestId || '').trim();
  const razorpayOrderId = String(body?.razorpay_order_id || '').trim();
  const razorpayPaymentId = String(body?.razorpay_payment_id || '').trim();
  const razorpaySignature = String(body?.razorpay_signature || '').trim();

  if (!mongoose.Types.ObjectId.isValid(requestId)) {
    throw createError(400, 'VALIDATION_ERROR', 'requestId is required');
  }
  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    throw createError(
      400,
      'VALIDATION_ERROR',
      'requestId, razorpay_order_id, razorpay_payment_id and razorpay_signature are required'
    );
  }

  const doc = await DropshipperRegistrationRequest.findById(requestId);
  if (!doc) throw createError(404, 'REQUEST_NOT_FOUND', 'Application not found');

  if (doc.payment?.status === 'paid' || ['pending_admin', 'pending_otp', 'active'].includes(doc.status)) {
    return {
      success: true,
      alreadyPaid: true,
      message: 'Payment already verified. Your application is pending admin approval.',
      request: { id: String(doc._id) }
    };
  }
  if (doc.status === 'rejected') {
    throw createError(409, 'APPLICATION_REJECTED', 'This application was rejected.');
  }
  if (doc.payment?.razorpayOrderId && doc.payment.razorpayOrderId !== razorpayOrderId) {
    throw createError(409, 'PAYMENT_ORDER_MISMATCH', 'Payment order does not match this application.');
  }

  assertPaymentSignature(razorpayOrderId, razorpayPaymentId, razorpaySignature);
  const { client } = getRazorpayClient();
  const expectedPaise = Math.round(Number(doc.amountDueInr || DEFAULT_FEE_INR) * 100);
  await assertCapturedRazorpayPayment(client, {
    orderId: razorpayOrderId,
    paymentId: razorpayPaymentId,
    expectedPaise
  });

  doc.status = 'pending_admin';
  doc.amountPaidInr = Number(doc.amountDueInr || 0);
  doc.payment.status = 'paid';
  doc.payment.razorpayOrderId = razorpayOrderId;
  doc.payment.razorpayPaymentId = razorpayPaymentId;
  doc.payment.paidAt = new Date();
  doc.markModified('payment');
  await doc.save();

  return {
    success: true,
    message: 'Payment verified successfully. Your application is now pending admin approval.',
    request: { id: String(doc._id), adminStatus: 'pending', status: doc.status }
  };
}

async function getRegistrationStatus(requestId, query) {
  if (!mongoose.Types.ObjectId.isValid(String(requestId || ''))) {
    throw createError(404, 'REQUEST_NOT_FOUND', 'Application not found');
  }
  const email = normalizeEmail(query?.email);
  const phone = normalizePhone(query?.phone);
  if (!email && !phone) {
    throw createError(400, 'VALIDATION_ERROR', 'Email or phone is required');
  }

  const doc = await DropshipperRegistrationRequest.findById(requestId).lean();
  if (!doc) throw createError(404, 'REQUEST_NOT_FOUND', 'Application not found');

  const emailOk = email && doc.email === email;
  const phoneOk = phone && doc.phone === phone;
  if (!emailOk && !phoneOk) {
    throw createError(404, 'REQUEST_NOT_FOUND', 'Application not found');
  }

  return {
    success: true,
    request: serializePublicStatus(doc),
    nextStep: nextStepFor(doc.status),
    message: statusMessage(doc.status)
  };
}

function profileFromRequest(request) {
  return {
    fullName: request.fullName,
    email: request.email,
    phone: request.phone,
    whatsappNumber: request.whatsappNumber,
    businessName: request.businessName || '',
    permanentAddress: request.permanentAddress,
    haveShop: request.haveShop === true,
    businessAddress: request.businessAddress,
    deliveryAddress: request.deliveryAddress,
    sellingPlaceFrom: request.sellingPlaceFrom,
    sellingZoneCity: request.sellingZoneCity,
    productCategory: request.productCategory,
    monthlyEstimatedPurchase: request.monthlyEstimatedPurchase,
    registrationRequestId: request._id,
    status: 'pending_otp',
    subscriptionYears: SUBSCRIPTION_YEARS,
    subscriptionStartedAt: null,
    subscriptionExpiresAt: null
  };
}

async function approveRequest(requestId, { note, reviewerId }) {
  if (!mongoose.Types.ObjectId.isValid(String(requestId || ''))) {
    throw createError(400, 'INVALID_ID', 'Invalid request id');
  }
  const request = await DropshipperRegistrationRequest.findById(requestId);
  if (!request) throw createError(404, 'REQUEST_NOT_FOUND', 'Application not found');
  if (request.status === 'pending_otp' || request.status === 'active') {
    throw createError(409, 'ALREADY_APPROVED', 'This application is already approved.');
  }
  if (request.status === 'rejected') {
    throw createError(409, 'ALREADY_REJECTED', 'This application was rejected.');
  }
  if (request.status !== 'pending_admin' || request.payment?.status !== 'paid') {
    throw createError(409, 'PAYMENT_REQUIRED', 'Payment must be verified before approval.');
  }

  const profile = profileFromRequest(request);
  let account = await Dropshipper.findOne({
    $or: [{ email: request.email }, { phone: request.phone }, { registrationRequestId: request._id }]
  });

  if (account && !['rejected', 'pending_otp'].includes(account.status)) {
    throw createError(409, 'ACCOUNT_ALREADY_EXISTS', 'An account already exists for this applicant.');
  }

  if (!account) {
    account = new Dropshipper(profile);
  } else {
    account.set(profile);
    account.password = undefined;
    account.activationOtpHash = undefined;
    account.activationOtpExpiresAt = null;
    account.activationOtpAttempts = 0;
    account.activationOtpSentAt = null;
    account.refreshTokens = [];
  }
  try {
    await account.save();
  } catch (err) {
    if (err?.code === 11000) {
      throw createError(409, 'ACCOUNT_ALREADY_EXISTS', 'An account already exists for this applicant.');
    }
    throw err;
  }

  request.status = 'pending_otp';
  request.dropshipperId = account._id;
  request.adminDecisionNote = String(note || '').trim();
  request.reviewedBy = reviewerId && mongoose.Types.ObjectId.isValid(String(reviewerId)) ? reviewerId : null;
  request.reviewedAt = new Date();
  await request.save();

  let otpSent = false;
  try {
    await issueActivationOtp(account, { ignoreCooldown: true });
    otpSent = true;
  } catch (err) {
    logger.error('[dropshipperAuth] OTP on approve failed', { message: err?.message, code: err?.code });
  }

  return {
    success: true,
    message: otpSent
      ? 'Application approved. Activation OTP sent to the applicant email.'
      : 'Application approved. OTP could not be sent; the applicant can request it from the activate page.',
    otpSent,
    request: serializeAdminRequest(request),
    account: serializeAdminAccount(account)
  };
}

async function rejectRequest(requestId, { note, reviewerId }) {
  if (!mongoose.Types.ObjectId.isValid(String(requestId || ''))) {
    throw createError(400, 'INVALID_ID', 'Invalid request id');
  }
  const request = await DropshipperRegistrationRequest.findById(requestId);
  if (!request) throw createError(404, 'REQUEST_NOT_FOUND', 'Application not found');
  if (request.status === 'rejected') {
    throw createError(409, 'ALREADY_REJECTED', 'This application is already rejected.');
  }
  if (['active', 'expired', 'suspended'].includes(request.status)) {
    throw createError(409, 'CANNOT_REJECT', 'An activated account cannot be rejected from this queue.');
  }
  if (!['pending_admin', 'pending_otp', 'pending_payment'].includes(request.status)) {
    throw createError(409, 'CANNOT_REJECT', `Request cannot be rejected from status ${request.status}.`);
  }

  const decision = String(note || '').trim() || 'Rejected by admin';
  request.status = 'rejected';
  request.adminDecisionNote = decision.slice(0, 500);
  request.reviewedBy = reviewerId && mongoose.Types.ObjectId.isValid(String(reviewerId)) ? reviewerId : null;
  request.reviewedAt = new Date();
  await request.save();

  if (request.dropshipperId) {
    await Dropshipper.updateOne(
      { _id: request.dropshipperId, status: 'pending_otp' },
      {
        $set: { status: 'rejected' },
        $unset: { activationOtpHash: 1, password: 1 }
      }
    );
  }

  return {
    success: true,
    message: 'Application rejected.',
    request: serializeAdminRequest(request)
  };
}

function parsePage(query) {
  const page = Math.max(parseInt(query?.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query?.limit, 10) || 20, 1), 100);
  return { page, limit, skip: (page - 1) * limit };
}

async function listRequests(query) {
  const { page, limit, skip } = parsePage(query);
  const filter = {};
  const status = String(query?.status || 'all').toLowerCase();
  const allowed = [
    'pending_payment',
    'pending_admin',
    'pending_otp',
    'active',
    'rejected',
    'expired',
    'suspended'
  ];
  if (status && status !== 'all') {
    if (!allowed.includes(status)) throw createError(400, 'VALIDATION_ERROR', 'Invalid status filter');
    filter.status = status;
  }
  const q = String(query?.q || query?.search || '').trim();
  if (q) {
    const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      { fullName: { $regex: safe, $options: 'i' } },
      { email: { $regex: safe, $options: 'i' } },
      { phone: { $regex: safe, $options: 'i' } },
      { businessName: { $regex: safe, $options: 'i' } }
    ];
  }

  const [rows, total] = await Promise.all([
    DropshipperRegistrationRequest.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    DropshipperRegistrationRequest.countDocuments(filter)
  ]);

  return {
    success: true,
    requests: rows.map(serializeAdminRequest),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(Math.ceil(total / limit), 1)
    }
  };
}

async function getRequest(requestId) {
  if (!mongoose.Types.ObjectId.isValid(String(requestId || ''))) {
    throw createError(400, 'INVALID_ID', 'Invalid request id');
  }
  const doc = await DropshipperRegistrationRequest.findById(requestId).lean();
  if (!doc) throw createError(404, 'REQUEST_NOT_FOUND', 'Application not found');
  return { success: true, request: serializeAdminRequest(doc) };
}

async function listAccounts(query) {
  const { page, limit, skip } = parsePage(query);
  const filter = {};
  const status = String(query?.status || 'all').toLowerCase();
  if (status && status !== 'all') {
    if (!BLOCKING_ACCOUNT_STATUSES.includes(status) && status !== 'rejected' && status !== 'pending_payment' && status !== 'pending_admin') {
      throw createError(400, 'VALIDATION_ERROR', 'Invalid status filter');
    }
    filter.status = status;
  }
  const q = String(query?.q || query?.search || '').trim();
  if (q) {
    const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      { fullName: { $regex: safe, $options: 'i' } },
      { email: { $regex: safe, $options: 'i' } },
      { phone: { $regex: safe, $options: 'i' } },
      { businessName: { $regex: safe, $options: 'i' } }
    ];
  }
  const [rows, total] = await Promise.all([
    Dropshipper.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Dropshipper.countDocuments(filter)
  ]);
  return {
    success: true,
    accounts: rows.map(serializeAdminAccount),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(Math.ceil(total / limit), 1)
    }
  };
}

async function getAccount(accountId) {
  if (!mongoose.Types.ObjectId.isValid(String(accountId || ''))) {
    throw createError(400, 'INVALID_ID', 'Invalid account id');
  }
  const doc = await Dropshipper.findById(accountId).lean();
  if (!doc) throw createError(404, 'ACCOUNT_NOT_FOUND', 'Dropshipper account not found');
  return { success: true, account: serializeAdminAccount(doc) };
}

async function updateSettings(body, reviewerId) {
  const doc = await getSettingsDoc();
  const hasFee = body && Object.prototype.hasOwnProperty.call(body, 'subscriptionAmountInr');
  const hasOpen = body && Object.prototype.hasOwnProperty.call(body, 'registrationOpen');
  if (!hasFee && !hasOpen) {
    throw createError(400, 'VALIDATION_ERROR', 'Provide subscriptionAmountInr and/or registrationOpen');
  }
  if (hasFee) {
    const n = Number(body.subscriptionAmountInr);
    if (!Number.isFinite(n) || n < 1 || n > 1000000) {
      throw createError(400, 'INVALID_FEE', 'Subscription fee must be between 1 and 1000000 INR');
    }
    doc.subscriptionAmountInr = roundMoney(n);
  }
  if (hasOpen) doc.registrationOpen = parseBool(body.registrationOpen);
  doc.subscriptionYears = SUBSCRIPTION_YEARS;
  if (reviewerId && mongoose.Types.ObjectId.isValid(String(reviewerId))) {
    doc.updatedBy = reviewerId;
  }
  await doc.save();
  return { success: true, message: 'Dropshipper settings updated', settings: serializeSettings(doc) };
}

async function syncExpiry(doc) {
  if (!doc) return doc;
  if (doc.status === 'active' && doc.subscriptionExpiresAt && new Date(doc.subscriptionExpiresAt).getTime() <= Date.now()) {
    doc.status = 'expired';
    await doc.save();
    if (doc.registrationRequestId) {
      await DropshipperRegistrationRequest.updateOne(
        { _id: doc.registrationRequestId, status: 'active' },
        { $set: { status: 'expired' } }
      );
    }
  }
  return doc;
}

async function findAccountForActivation({ email, phone, dropshipperId }) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedEmail && !normalizedPhone && !dropshipperId) {
    throw createError(400, 'VALIDATION_ERROR', 'Email or phone is required');
  }
  if (dropshipperId && !mongoose.Types.ObjectId.isValid(String(dropshipperId))) {
    throw createError(400, 'VALIDATION_ERROR', 'Invalid dropshipper id');
  }

  const clauses = [];
  if (dropshipperId) clauses.push({ _id: dropshipperId });
  if (normalizedEmail) clauses.push({ email: normalizedEmail });
  if (normalizedPhone) clauses.push({ phone: normalizedPhone });

  const matches = await Dropshipper.find({ $or: clauses }).select(
    '+activationOtpHash +password'
  );
  if (matches.length > 1) {
    const ids = new Set(matches.map((row) => String(row._id)));
    if (ids.size > 1) {
      throw createError(
        409,
        'IDENTITY_CONFLICT',
        'Email and phone belong to different accounts. Contact support.'
      );
    }
  }
  const account = matches[0] || null;
  if (!account) {
    throw createError(
      404,
      'ACTIVATION_NOT_FOUND',
      'No approved application found for this email or phone.'
    );
  }
  if (normalizedEmail && account.email !== normalizedEmail) {
    throw createError(404, 'ACTIVATION_NOT_FOUND', 'No approved application found for this email or phone.');
  }
  if (normalizedPhone && account.phone !== normalizedPhone) {
    throw createError(404, 'ACTIVATION_NOT_FOUND', 'No approved application found for this email or phone.');
  }
  return account;
}

async function deliverActivationEmail(account, otp) {
  try {
    await deliverOtpFor({
      email: account.email,
      phone: account.phone,
      otp,
      purpose: 'dropshipper_activation',
      forceChannel: 'email'
    });
    return { emailed: true };
  } catch (err) {
    logger.error('[dropshipperAuth] activation email failed', { message: err?.message, code: err?.code });
    if (isProduction()) {
      throw createError(502, 'OTP_SEND_FAILED', 'Could not send activation OTP. Please try again.');
    }
    return { emailed: false };
  }
}

async function issueActivationOtp(account, { ignoreCooldown = false } = {}) {
  if (account.status === 'active' || account.status === 'expired') {
    throw createError(409, 'ALREADY_ACTIVATED', 'This account is already activated. Please login.');
  }
  if (account.status === 'suspended') {
    throw createError(403, 'ACCOUNT_SUSPENDED', 'This account is suspended.');
  }
  if (account.status === 'rejected') {
    throw createError(403, 'APPLICATION_REJECTED', 'This application was rejected.');
  }
  if (account.status !== 'pending_otp') {
    throw createError(
      409,
      'AWAITING_ADMIN_APPROVAL',
      'Admin must approve your paid request before activation.'
    );
  }

  const sentAt = account.activationOtpSentAt ? new Date(account.activationOtpSentAt).getTime() : 0;
  if (!ignoreCooldown && sentAt && Date.now() - sentAt < OTP_COOLDOWN_MS) {
    throw createError(429, 'OTP_RESEND_COOLDOWN', 'Please wait before requesting another OTP.');
  }

  const otp = generateOTP();
  account.activationOtpHash = hashString(otp);
  account.activationOtpExpiresAt = new Date(Date.now() + getOtpExpiryMs());
  account.activationOtpAttempts = 0;
  account.activationOtpSentAt = new Date();
  await account.save();

  const delivery = await deliverActivationEmail(account, otp);
  const payload = {
    success: true,
    message: delivery.emailed
      ? 'OTP sent to your registered email.'
      : 'OTP generated. Email delivery is unavailable in this environment.'
  };
  if (!isProduction()) payload.debugOtp = otp;
  return payload;
}

async function sendActivationOtp(body) {
  const account = await findAccountForActivation(body || {});
  return issueActivationOtp(account);
}

async function completeActivation(body) {
  const otp = String(body?.otp || '').trim();
  const password = String(body?.password || '');
  const confirmPassword = body?.confirmPassword != null ? String(body.confirmPassword) : null;

  if (!/^\d{4,8}$/.test(otp)) throw createError(400, 'VALIDATION_ERROR', 'OTP is required');
  if (password.length < 8) {
    throw createError(400, 'WEAK_PASSWORD', 'Password must be at least 8 characters.');
  }
  if (confirmPassword != null && confirmPassword !== password) {
    throw createError(400, 'PASSWORD_MISMATCH', 'Password and confirm password do not match.');
  }

  const account = await findAccountForActivation(body || {});
  if (account.status === 'active' || account.status === 'expired') {
    throw createError(409, 'ALREADY_ACTIVATED', 'This account is already activated. Please login.');
  }
  if (account.status !== 'pending_otp') {
    throw createError(409, 'AWAITING_ADMIN_APPROVAL', 'Admin must approve your application before activation.');
  }
  if (!account.activationOtpHash || !account.activationOtpExpiresAt) {
    throw createError(400, 'OTP_EXPIRED_OR_MISSING', 'OTP expired or not requested');
  }
  if (new Date() > new Date(account.activationOtpExpiresAt)) {
    throw createError(400, 'OTP_EXPIRED', 'OTP has expired. Request a new one.');
  }
  if (Number(account.activationOtpAttempts || 0) >= MAX_OTP_ATTEMPTS) {
    throw createError(429, 'OTP_MAX_ATTEMPTS', 'Too many invalid attempts. Request OTP again.');
  }
  if (!safeEqual(hashString(otp), account.activationOtpHash)) {
    account.activationOtpAttempts = Number(account.activationOtpAttempts || 0) + 1;
    await account.save();
    throw createError(400, 'OTP_INVALID', 'Invalid OTP');
  }

  const now = new Date();
  account.password = await bcrypt.hash(password, BCRYPT_ROUNDS);
  account.activationOtpHash = undefined;
  account.activationOtpExpiresAt = null;
  account.activationOtpAttempts = 0;
  account.status = 'active';
  account.subscriptionYears = SUBSCRIPTION_YEARS;
  account.subscriptionStartedAt = now;
  account.subscriptionExpiresAt = addYears(now, SUBSCRIPTION_YEARS);
  await account.save();

  if (account.registrationRequestId) {
    await DropshipperRegistrationRequest.updateOne(
      { _id: account.registrationRequestId },
      { $set: { status: 'active', dropshipperId: account._id } }
    );
  }

  return {
    success: true,
    message: 'Account activated. Your 1-year subscription has started. Please login.'
  };
}

function signAccessToken(accountId) {
  const secret = String(process.env.JWT_SECRET || '').trim();
  if (!secret) throw createError(503, 'AUTH_NOT_CONFIGURED', 'Login is temporarily unavailable.');
  return jwt.sign(
    {
      id: String(accountId),
      type: 'access',
      portal: 'dropshipper',
      role: 'dropshipper',
      userType: 'dropshipper'
    },
    secret,
    { expiresIn: ACCESS_EXPIRES() }
  );
}

function signRefreshToken(accountId) {
  const secret = String(process.env.REFRESH_TOKEN_SECRET || '').trim();
  if (!secret) throw createError(503, 'AUTH_NOT_CONFIGURED', 'Login is temporarily unavailable.');
  return jwt.sign(
    {
      id: String(accountId),
      type: 'refresh',
      portal: 'dropshipper',
      jti: crypto.randomUUID()
    },
    secret,
    { expiresIn: REFRESH_EXPIRES() }
  );
}

async function storeRefreshToken(account, refreshToken) {
  const decoded = jwt.decode(refreshToken);
  const expiresAt = decoded?.exp ? new Date(decoded.exp * 1000) : null;
  const now = Date.now();
  const sessions = (account.refreshTokens || []).filter(
    (row) => row?.tokenHash && (!row.expiresAt || new Date(row.expiresAt).getTime() > now)
  );
  sessions.push({ tokenHash: hashString(refreshToken), expiresAt, createdAt: new Date() });
  account.refreshTokens = sessions.slice(-MAX_REFRESH_SESSIONS);
  await account.save();
}

async function issueSession(account) {
  const accessToken = signAccessToken(account._id);
  const refreshToken = signRefreshToken(account._id);
  await storeRefreshToken(account, refreshToken);
  return {
    success: true,
    accessToken,
    refreshToken,
    dropshipper: serializePublicAccount(account)
  };
}

async function login(body) {
  const email = normalizeEmail(body?.email);
  const phone = normalizePhone(body?.phone);
  const password = String(body?.password || '');
  if ((!email && !phone) || !password) {
    throw createError(400, 'VALIDATION_ERROR', 'Email or phone and password are required');
  }
  if (email && phone) {
    throw createError(400, 'VALIDATION_ERROR', 'Provide either email or phone');
  }

  const account = await Dropshipper.findOne(email ? { email } : { phone }).select(
    '+password +refreshTokens'
  );
  if (!account || account.status === 'rejected') {
    throw createError(401, 'INVALID_CREDENTIALS', 'Invalid email/phone or password.');
  }
  if (account.status === 'suspended') {
    throw createError(403, 'ACCOUNT_SUSPENDED', 'This account is suspended.');
  }
  if (account.status === 'pending_otp' || !account.password) {
    throw createError(
      403,
      'ACCOUNT_NOT_ACTIVATED',
      'Activate your account with the OTP before logging in.'
    );
  }
  const matches = await bcrypt.compare(password, account.password);
  if (!matches) {
    throw createError(401, 'INVALID_CREDENTIALS', 'Invalid email/phone or password.');
  }

  await syncExpiry(account);
  const session = await issueSession(account);
  return {
    ...session,
    message: 'Login successful'
  };
}

async function refreshSession(body) {
  const refreshToken = String(body?.refreshToken || '').trim();
  if (!refreshToken) throw createError(401, 'REFRESH_TOKEN_MISSING', 'Refresh token missing');
  const secret = String(process.env.REFRESH_TOKEN_SECRET || '').trim();
  if (!secret) throw createError(503, 'AUTH_NOT_CONFIGURED', 'Login is temporarily unavailable.');

  let decoded;
  try {
    decoded = jwt.verify(refreshToken, secret);
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw createError(401, 'REFRESH_TOKEN_EXPIRED', 'Refresh token has expired');
    }
    throw createError(401, 'INVALID_REFRESH_TOKEN', 'Invalid refresh token');
  }
  if (decoded?.type !== 'refresh' || decoded?.portal !== 'dropshipper' || !decoded?.id) {
    throw createError(401, 'INVALID_REFRESH_TOKEN', 'Invalid refresh token');
  }

  const account = await Dropshipper.findById(decoded.id).select('+refreshTokens +password');
  if (!account || account.status === 'rejected') {
    throw createError(401, 'INVALID_REFRESH_TOKEN', 'Invalid refresh token');
  }
  if (account.status === 'suspended') {
    throw createError(403, 'ACCOUNT_SUSPENDED', 'This account is suspended.');
  }
  if (!['active', 'expired'].includes(account.status)) {
    throw createError(403, 'ACCOUNT_NOT_ACTIVE', 'Account is not active.');
  }

  const tokenHash = hashString(refreshToken);
  const sessions = account.refreshTokens || [];
  const matchIndex = sessions.findIndex((row) => row?.tokenHash === tokenHash);
  if (matchIndex < 0) {
    throw createError(401, 'REFRESH_TOKEN_REVOKED', 'Refresh token is no longer valid');
  }
  sessions.splice(matchIndex, 1);
  account.refreshTokens = sessions;
  await syncExpiry(account);
  const session = await issueSession(account);
  return { success: true, accessToken: session.accessToken, refreshToken: session.refreshToken };
}

async function blacklistAccessToken(token) {
  if (!token) return;
  const decoded = jwt.decode(token);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const ttl = decoded?.exp ? Math.max(0, decoded.exp - nowSeconds) : 0;
  const redis = redisManager.getRedisClient();
  if (redis) {
    try {
      await redis.set(`bl_${token}`, '1');
      if (ttl > 0) await redis.expire(`bl_${token}`, ttl);
      return;
    } catch (err) {
      logger.warn('[dropshipperAuth] redis blacklist failed', { message: err?.message });
    }
  }
  tokenStore.add(token, ttl);
}

async function isAccessTokenBlacklisted(token) {
  const redis = redisManager.getRedisClient();
  if (redis) {
    try {
      const hit = await redis.get(`bl_${token}`);
      if (hit) return true;
    } catch (err) {
      if (tokenStore.has(token)) return true;
    }
  }
  return tokenStore.has(token);
}

function readBearer(headerValue) {
  const raw = String(headerValue || '').trim();
  if (!raw) return '';
  return raw.startsWith('Bearer ') ? raw.slice(7).trim() : raw;
}

async function authenticateAccessToken(token) {
  const secret = String(process.env.JWT_SECRET || '').trim();
  if (!secret) throw createError(503, 'AUTH_NOT_CONFIGURED', 'Login is temporarily unavailable.');
  if (!token) throw createError(401, 'MISSING_TOKEN', 'Login required');

  let decoded;
  try {
    decoded = jwt.verify(token, secret);
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw createError(401, 'TOKEN_EXPIRED', 'Token has expired');
    }
    throw createError(401, 'INVALID_TOKEN', 'Invalid token');
  }

  if (decoded?.type !== 'access' || decoded?.portal !== 'dropshipper' || !decoded?.id) {
    throw createError(401, 'DROPSHIPPER_AUTH_REQUIRED', 'Dropshipper login required');
  }
  if (await isAccessTokenBlacklisted(token)) {
    throw createError(401, 'TOKEN_BLACKLISTED', 'Token is blacklisted');
  }

  const account = await Dropshipper.findById(decoded.id);
  if (!account || account.status === 'rejected') {
    throw createError(401, 'UNAUTHORIZED', 'Dropshipper account not found');
  }
  await syncExpiry(account);
  return {
    id: String(account._id),
    doc: account,
    publicProfile: serializePublicAccount(account)
  };
}

function subscriptionGate(profile) {
  const status = profile?.status;
  if (status === 'suspended') {
    return {
      ok: false,
      status: 403,
      code: 'ACCOUNT_SUSPENDED',
      message: 'This account is suspended.'
    };
  }
  if (status === 'expired' || profile?.subscriptionActive === false && status === 'active') {
    return {
      ok: false,
      status: 403,
      code: 'SUBSCRIPTION_EXPIRED',
      message: 'Subscription expired. Renew to continue.'
    };
  }
  if (status !== 'active' || profile?.subscriptionActive !== true) {
    if (status === 'expired') {
      return {
        ok: false,
        status: 403,
        code: 'SUBSCRIPTION_EXPIRED',
        message: 'Subscription expired. Renew to continue.'
      };
    }
    return {
      ok: false,
      status: 403,
      code: 'ACCOUNT_NOT_ACTIVE',
      message: 'Account is not active.'
    };
  }
  return { ok: true };
}

async function logout({ accessToken, refreshToken, dropshipperId }) {
  await blacklistAccessToken(accessToken);
  if (refreshToken && dropshipperId && mongoose.Types.ObjectId.isValid(String(dropshipperId))) {
    const account = await Dropshipper.findById(dropshipperId).select('+refreshTokens');
    if (account) {
      const tokenHash = hashString(refreshToken);
      account.refreshTokens = (account.refreshTokens || []).filter((row) => row?.tokenHash !== tokenHash);
      await account.save();
    }
  }
  return { success: true, message: 'Logged out successfully' };
}

async function loadRenewableAccount(dropshipperId) {
  if (!dropshipperId || !mongoose.Types.ObjectId.isValid(String(dropshipperId))) {
    throw createError(401, 'UNAUTHORIZED', 'Login required');
  }
  const account = await Dropshipper.findById(dropshipperId);
  if (!account) throw createError(401, 'UNAUTHORIZED', 'Dropshipper account not found');
  await syncExpiry(account);
  if (account.status === 'suspended') {
    throw createError(403, 'ACCOUNT_SUSPENDED', 'This account is suspended.');
  }
  if (!['active', 'expired'].includes(account.status)) {
    throw createError(403, 'ACCOUNT_NOT_ACTIVE', 'Activate your account before renewing.');
  }
  return account;
}

function buildRenewQuote(account, fee) {
  const now = new Date();
  const currentExpiry = account.subscriptionExpiresAt ? new Date(account.subscriptionExpiresAt) : null;
  const renewsFrom = currentExpiry && currentExpiry.getTime() > now.getTime() ? currentExpiry : now;
  return {
    subscriptionAmountInr: fee,
    subscriptionYears: SUBSCRIPTION_YEARS,
    currency: 'INR',
    currentStatus: account.status,
    subscriptionExpiresAt: account.subscriptionExpiresAt || null,
    renewsFrom,
    nextExpiresAt: addYears(renewsFrom, SUBSCRIPTION_YEARS)
  };
}

async function renewQuote(dropshipperId) {
  const account = await loadRenewableAccount(dropshipperId);
  const settings = await getSettingsDoc();
  return {
    success: true,
    quote: buildRenewQuote(account, feeFromSettings(settings))
  };
}

async function renewCreatePayment(dropshipperId) {
  const account = await loadRenewableAccount(dropshipperId);
  const settings = await getSettingsDoc();
  const fee = feeFromSettings(settings);
  const amountPaise = Math.round(fee * 100);
  const { client, keyId } = getRazorpayClient();

  let order;
  try {
    order = await client.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: `dsren-${String(account._id).slice(-12)}-${Date.now().toString(36)}`.slice(0, 40),
      payment_capture: 1,
      notes: {
        type: 'dropshipper_renewal',
        dropshipperId: String(account._id)
      }
    });
  } catch (err) {
    logger.error('[dropshipperAuth] Razorpay renewal order failed', { message: err?.message });
    throw createError(503, 'RAZORPAY_ORDER_FAILED', 'Could not start renewal payment. Please try again.');
  }

  account.renewalPending = {
    razorpayOrderId: order.id,
    amountInr: fee,
    amountPaise,
    createdAt: new Date()
  };
  account.markModified('renewalPending');
  await account.save();

  return {
    success: true,
    message: 'Renewal payment order created.',
    razorpay: {
      keyId,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency || 'INR'
    },
    quote: buildRenewQuote(account, fee)
  };
}

async function renewVerifyPayment(dropshipperId, body) {
  const account = await loadRenewableAccount(dropshipperId);
  const razorpayOrderId = String(body?.razorpay_order_id || '').trim();
  const razorpayPaymentId = String(body?.razorpay_payment_id || '').trim();
  const razorpaySignature = String(body?.razorpay_signature || '').trim();
  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    throw createError(
      400,
      'VALIDATION_ERROR',
      'razorpay_order_id, razorpay_payment_id and razorpay_signature are required'
    );
  }

  const already = (account.renewalHistory || []).find((row) => row.razorpayPaymentId === razorpayPaymentId);
  if (already) {
    return {
      success: true,
      alreadyRenewed: true,
      message: 'Subscription renewal already applied.',
      dropshipper: serializePublicAccount(account)
    };
  }

  if (!account.renewalPending?.razorpayOrderId || account.renewalPending.razorpayOrderId !== razorpayOrderId) {
    throw createError(409, 'PAYMENT_ORDER_MISMATCH', 'Payment order does not match the latest renewal attempt.');
  }

  assertPaymentSignature(razorpayOrderId, razorpayPaymentId, razorpaySignature);
  const { client } = getRazorpayClient();
  const expectedPaise = Number(account.renewalPending.amountPaise);
  await assertCapturedRazorpayPayment(client, {
    orderId: razorpayOrderId,
    paymentId: razorpayPaymentId,
    expectedPaise
  });

  const previousExpiresAt = account.subscriptionExpiresAt || null;
  const now = new Date();
  const base =
    previousExpiresAt && new Date(previousExpiresAt).getTime() > now.getTime()
      ? new Date(previousExpiresAt)
      : now;
  const nextExpiresAt = addYears(base, SUBSCRIPTION_YEARS);

  account.status = 'active';
  account.subscriptionYears = SUBSCRIPTION_YEARS;
  if (!account.subscriptionStartedAt) account.subscriptionStartedAt = now;
  account.subscriptionExpiresAt = nextExpiresAt;
  account.renewalHistory = [
    ...(account.renewalHistory || []),
    {
      razorpayOrderId,
      razorpayPaymentId,
      amountInr: account.renewalPending.amountInr,
      paidAt: now,
      previousExpiresAt,
      nextExpiresAt
    }
  ].slice(-20);
  account.renewalPending = undefined;
  account.markModified('renewalHistory');
  await account.save();

  if (account.registrationRequestId) {
    await DropshipperRegistrationRequest.updateOne(
      { _id: account.registrationRequestId },
      { $set: { status: 'active' } }
    );
  }

  return {
    success: true,
    message: 'Subscription renewed for 1 year.',
    dropshipper: serializePublicAccount(account)
  };
}

async function getMe(dropshipperId) {
  const account = await Dropshipper.findById(dropshipperId);
  if (!account) throw createError(401, 'UNAUTHORIZED', 'Dropshipper account not found');
  await syncExpiry(account);
  return { success: true, dropshipper: serializePublicAccount(account) };
}

module.exports = {
  SUBSCRIPTION_YEARS,
  DEFAULT_FEE_INR,
  isProduction,
  createError,
  getSubscriptionSettings,
  startRegistration,
  createRegistrationPayment,
  verifyRegistrationPayment,
  getRegistrationStatus,
  approveRequest,
  rejectRequest,
  listRequests,
  getRequest,
  listAccounts,
  getAccount,
  updateSettings,
  sendActivationOtp,
  completeActivation,
  login,
  refreshSession,
  logout,
  renewQuote,
  renewCreatePayment,
  renewVerifyPayment,
  getMe,
  authenticateAccessToken,
  subscriptionGate,
  readBearer,
  serializeSettings
};
