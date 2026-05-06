'use strict';

const express         = require('express');
const Joi             = require('joi');
const crypto          = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db              = require('../db');
const logger          = require('../logger');
const { requireAuth, requireRole } = require('../middleware/auth');
const stripeService   = require('../services/stripe');
const selcomService   = require('../services/selcom');
const mpesaKEService  = require('../services/mpesaKenya');

const router = express.Router();

const initiateSchema = Joi.object({
  method:          Joi.string().valid('card','mpesa','tigopesa','selcom','airtel','mtn','bank').required(),
  paymentMethodId: Joi.string().when('method', { is: 'card', then: Joi.required() }),
  phone:           Joi.string().when('method', { is: Joi.not('card','bank'), then: Joi.required() }),
  currency:        Joi.string().default('tzs'),
  orderId:         Joi.string().uuid().required(),
  country:         Joi.string().valid('TZ','KE').required(),
});

// POST /api/payments/initiate
router.post('/initiate', requireAuth, async (req, res, next) => {
  try {
    const { error, value } = initiateSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    // Fetch the order to get the authoritative amount — never trust client-supplied amount
    const orderResult = await db.query(
      'SELECT total_tzs, status FROM orders WHERE id = $1 AND customer_id = $2',
      [value.orderId, req.session.userId]
    );
    if (!orderResult.rows.length) {
      return res.status(404).json({ error: 'Order not found' });
    }
    const order = orderResult.rows[0];
    if (order.status !== 'pending') {
      return res.status(400).json({ error: 'Order is not in a payable state' });
    }
    const amount = order.total_tzs;

    // Idempotency: reject if a non-failed payment already exists for this order
    const existing = await db.query(
      "SELECT id FROM payments WHERE order_id = $1 AND status IN ('pending','completed')",
      [value.orderId]
    );
    if (existing.rows.length) {
      return res.status(409).json({ error: 'A payment for this order already exists' });
    }

    const ref = uuidv4();
    let providerRef = null;

    if (value.method === 'card') {
      const pi = await stripeService.createPaymentIntent(amount, 'tzs', value.orderId);
      providerRef = pi.id;
    } else if (value.method === 'mpesa' && value.country === 'KE') {
      const result = await mpesaKEService.initiateSTKPush(value.phone, amount, value.orderId);
      providerRef = result.CheckoutRequestID;
    } else if (['mpesa','tigopesa','selcom','airtel'].includes(value.method)) {
      const result = await selcomService.initiatePush(value.phone, amount, value.orderId, value.method);
      providerRef = result.transactionId;
    }
    // bank: manual transfer — no provider call needed

    await db.query(
      `INSERT INTO payments (id, order_id, method, ref, provider_ref, status, amount_tzs)
       VALUES ($1,$2,$3,$4,$5,'pending',$6)`,
      [uuidv4(), value.orderId, value.method, ref, providerRef, amount]
    );

    logger.info('Payment initiated', { ref, method: value.method, country: value.country });
    res.json({ ref });
  } catch (err) {
    next(err);
  }
});

// GET /api/payments/:ref/status
router.get('/:ref/status', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT p.* FROM payments p
         JOIN orders o ON o.id = p.order_id
        WHERE p.ref = $1 AND (o.customer_id = $2 OR $3 = 'admin')`,
      [req.params.ref, req.session.userId, req.session.role]
    );
    if (!rows.length) return res.status(404).json({ error: 'Payment not found' });

    const payment = rows[0];

    // For Stripe: poll PaymentIntent status if still pending
    if (payment.method === 'card' && payment.status === 'pending' && payment.provider_ref) {
      try {
        const pi = await stripeService.confirmPayment(payment.provider_ref);
        if (pi.status === 'succeeded') {
          await db.query("UPDATE payments SET status='completed',updated_at=NOW() WHERE ref=$1", [req.params.ref]);
          payment.status = 'completed';
        } else if (['canceled','requires_payment_method'].includes(pi.status)) {
          await db.query("UPDATE payments SET status='failed',updated_at=NOW() WHERE ref=$1", [req.params.ref]);
          payment.status = 'failed';
        }
      } catch { /* keep current status */ }
    }

    res.json({ ref: payment.ref, status: payment.status, method: payment.method });
  } catch (err) {
    next(err);
  }
});

// POST /api/payments/stripe/webhook
// Must use raw body — registered with express.raw() in index.js before JSON middleware
router.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res, next) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripeService.constructWebhookEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    logger.warn('Stripe webhook signature verification failed', { error: err.message });
    return res.status(400).json({ error: 'Webhook signature invalid' });
  }

  try {
    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data.object;
      await db.query(
        "UPDATE payments SET status='completed', updated_at=NOW() WHERE provider_ref=$1",
        [pi.id]
      );
      logger.info('Stripe payment confirmed via webhook', { paymentIntentId: pi.id });
    } else if (event.type === 'payment_intent.payment_failed') {
      const pi = event.data.object;
      await db.query(
        "UPDATE payments SET status='failed', updated_at=NOW() WHERE provider_ref=$1",
        [pi.id]
      );
      logger.info('Stripe payment failed via webhook', { paymentIntentId: pi.id });
    }
    res.json({ received: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/payments/mpesa/callback — Safaricom Daraja STK push result
router.post('/mpesa/callback', async (req, res, next) => {
  try {
    const body = req.body?.Body?.stkCallback;
    if (!body) return res.json({ ResultCode: 0 });

    const checkoutRequestId = body.CheckoutRequestID;
    const resultCode        = body.ResultCode;

    if (resultCode === 0) {
      await db.query(
        "UPDATE payments SET status='completed', updated_at=NOW() WHERE provider_ref=$1",
        [checkoutRequestId]
      );
      logger.info('M-Pesa KE payment confirmed', { checkoutRequestId });
    } else {
      await db.query(
        "UPDATE payments SET status='failed', updated_at=NOW() WHERE provider_ref=$1",
        [checkoutRequestId]
      );
      logger.info('M-Pesa KE payment failed', { checkoutRequestId, resultCode });
    }

    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  } catch (err) {
    next(err);
  }
});

// Verify Selcom callback using HMAC-SHA256 of the request body
function verifySelcomCallback(req) {
  const secret = process.env.SELCOM_API_SECRET;
  if (!secret) return true; // not configured — skip in dev/sandbox
  const signature = req.headers['x-selcom-signature'] || req.headers['authorization'] || '';
  const bodyStr = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  const expected = crypto.createHmac('sha256', secret).update(bodyStr).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// POST /api/payments/selcom/callback — Selcom TZ push result
router.post('/selcom/callback', async (req, res, next) => {
  try {
    if (!verifySelcomCallback(req)) {
      logger.warn('Selcom callback signature mismatch', { ip: req.ip });
      return res.status(400).json({ result: 'FAIL' });
    }

    const { transid, utilityref, result } = req.body || {};
    if (!utilityref) return res.json({ result: 'SUCCESS' });

    if (result === 'SUCCESS') {
      await db.query(
        "UPDATE payments SET status='completed', updated_at=NOW() WHERE provider_ref=$1",
        [transid]
      );
      logger.info('Selcom TZ payment confirmed', { transid, utilityref });
    } else {
      await db.query(
        "UPDATE payments SET status='failed', updated_at=NOW() WHERE provider_ref=$1",
        [transid]
      );
      logger.info('Selcom TZ payment failed', { transid, result });
    }

    res.json({ result: 'SUCCESS' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
