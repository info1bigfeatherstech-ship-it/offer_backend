/**
 * Expires unpaid online orders after the payment hold window, releases reserved inventory,
 * and merges order lines back into the user's cart (cart was cleared when the order was created).
 * Safe under multi-instance: each document is updated inside a transaction with a state check.
 */
const mongoose = require('mongoose');
const Order = require('../models/Order');
const logger = require('../utils/logger');
const { releaseReservedInventoryForOrder } = require('./orderInventory.service');
const { mergeOrderLineItemsIntoUserCart } = require('./restoreCartFromOrder.service');

function getPaymentHoldMs() {
  const mins = Math.min(24 * 60, Math.max(5, Number(process.env.PAYMENT_HOLD_MINUTES || 30)));
  return mins * 60 * 1000;
}

function getScanIntervalMs() {
  const mins = Math.min(60, Math.max(1, Number(process.env.PAYMENT_HOLD_SCAN_INTERVAL_MINUTES || 5)));
  return mins * 60 * 1000;
}

/**
 * @param {import('mongoose').Document | object} order
 * @param {number} [atMs=Date.now()]
 */
function isOrderPaymentHoldExpired(order, atMs = Date.now()) {
  const holdMs = getPaymentHoldMs();
  if (order.paymentHoldExpiresAt) {
    return new Date(order.paymentHoldExpiresAt).getTime() <= atMs;
  }
  const created = order.createdAt ? new Date(order.createdAt).getTime() : atMs;
  return created + holdMs <= atMs;
}

function buildStaleUnpaidOnlineFilter(now) {
  const holdMs = getPaymentHoldMs();
  const cutoffLegacy = new Date(now.getTime() - holdMs);

  return {
    orderStatus: 'pending',
    paymentStatus: 'pending',
    'paymentInfo.method': 'online',
    $and: [
      {
        $or: [{ amountPaidInr: { $lte: 0.005 } }, { amountPaidInr: { $exists: false } }]
      },
      {
        $or: [
          { paymentHoldExpiresAt: { $lte: now } },
          {
            $and: [
              {
                $or: [{ paymentHoldExpiresAt: null }, { paymentHoldExpiresAt: { $exists: false } }]
              },
              { createdAt: { $lte: cutoffLegacy } }
            ]
          }
        ]
      }
    ]
  };
}

class PaymentHoldExpiryService {
  constructor() {
    this.interval = null;
    this.isRunning = false;
  }

  async expireStaleUnpaidOrders() {
    if (this.isRunning) {
      logger.debug('[paymentHold] Previous run still in progress, skip');
      return { skipped: true };
    }
    this.isRunning = true;
    const now = new Date();
    let processed = 0;
    let errors = 0;

    try {
      const filter = buildStaleUnpaidOnlineFilter(now);
      const batch = await Order.find(filter).sort({ createdAt: 1 }).limit(100).exec();

      for (const lean of batch) {
        const session = await mongoose.startSession();
        session.startTransaction();
        try {
          const order = await Order.findOne({
            _id: lean._id,
            orderStatus: 'pending',
            paymentStatus: 'pending',
            'paymentInfo.method': 'online'
          }).session(session);

          if (!order) {
            await session.abortTransaction();
            session.endSession();
            continue;
          }

          const paid = Number(order.amountPaidInr || 0);
          if (paid > 0.01) {
            await session.abortTransaction();
            session.endSession();
            continue;
          }

          if (!isOrderPaymentHoldExpired(order, now.getTime())) {
            await session.abortTransaction();
            session.endSession();
            continue;
          }

          order.orderStatus = 'cancelled';
          order.paymentStatus = 'failed';
          order.amountPaidInr = 0;
          order.balanceDueInr = 0;
          order.paymentInfo = order.paymentInfo || {};
          order.paymentInfo.status = 'expired';
          order.paymentInfo.cancellationReason = 'payment_timeout';
          order.paymentInfo.cancelledAt = now;
          order.markModified('paymentInfo');
          await order.save({ session });

          await releaseReservedInventoryForOrder(order, session);
          await mergeOrderLineItemsIntoUserCart(order.userId, order.items, session, order.storefront || 'ecomm');

          await session.commitTransaction();
          session.endSession();
          processed += 1;
          logger.info('[paymentHold] Expired unpaid order', { orderId: order.orderId });
        } catch (err) {
          await session.abortTransaction().catch(() => {});
          session.endSession();
          errors += 1;
          logger.error('[paymentHold] Batch item failed', {
            orderId: lean.orderId,
            message: err.message,
            stack: err.stack
          });
        }
      }

      if (processed > 0 || errors > 0) {
        logger.info('[paymentHold] Run complete', { processed, errors, scanned: batch.length });
      }
      return { processed, errors, scanned: batch.length };
    } catch (err) {
      logger.error('[paymentHold] Run failed', { message: err.message, stack: err.stack });
      return { processed, errors: errors + 1 };
    } finally {
      this.isRunning = false;
    }
  }

  start() {
    if (this.interval) {
      logger.warn('[paymentHold] Already started');
      return;
    }

    this.expireStaleUnpaidOrders().catch((e) =>
      logger.error('[paymentHold] Initial run error', { message: e.message })
    );

    this.interval = setInterval(() => {
      this.expireStaleUnpaidOrders().catch((e) =>
        logger.error('[paymentHold] Interval run error', { message: e.message })
      );
    }, getScanIntervalMs());

    logger.info('[paymentHold] Scheduler started', {
      intervalMinutes: getScanIntervalMs() / 60000,
      holdMinutes: getPaymentHoldMs() / 60000
    });
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      logger.info('[paymentHold] Scheduler stopped');
    }
  }
}

const paymentHoldExpiryService = new PaymentHoldExpiryService();
paymentHoldExpiryService.getPaymentHoldMs = getPaymentHoldMs;
paymentHoldExpiryService.isOrderPaymentHoldExpired = isOrderPaymentHoldExpired;
paymentHoldExpiryService.buildStaleUnpaidOnlineFilter = buildStaleUnpaidOnlineFilter;
module.exports = paymentHoldExpiryService;
