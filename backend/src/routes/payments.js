'use strict';

const express         = require('express');
const Joi             = require('joi');
const { v4: uuidv4 } = require('uuid');
const db              = require('../db');
const logger          = require('../logger');
const { requireAuth } = require('../middleware/auth');
const stripeService   = require('../services/stripe');
const selcomService   = require('../services/selcom');
const mpesaKEService  = require('../services/mpesaKenya');

const router = express.Router();

const initiateSchema = Joi.object({
  method:          Joi.string().valid('card','mpesa','tigopesa','selcom','airtel','mtn','bank').required(),
  paymentMethodId: Joi.string().when('method', { is: 'card', then: Joi.required() }),
  phone:           Joi.string().when('method', { is: Joi.not('card','bank'), then: Joi.required() }),
  amount:          Joi.number().integer().min(1).required(),
  currency:        Joi.string().default('tzs'),
  orderId:         Joi.string().required(),
  country:         Joi.string().valid('TZ','KE').required(),
});

// POST /api/payments/initiate
router.post('/initiate', requireAuth, async (req, res, next) => {
  try {
    const { error, value } = initiateSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const ref = uuidv4();
    let providerRef = null;

    if (value.method === 'card') {
      const pi = await stripeService.createPaymentIntent(value.amount, 'tzs', value.orderId);
      providerRef = pi.id;
    } else if (value.method === 'mpesa' && value.country === 'KE') {
      const result = await mpesaKEService.initiateSTKPush(value.phone, value.amount, value.orderId);
      providerRef = result.CheckoutRequestID;
    } else if (['mpesa','tigopesa','selcom','airtel'].includes(value.method)) {
      const result = await selcomService.initiatePush(value.phone, value.amount, value.orderId, value.method);
      providerRef = result.transactionId;
    }
    // bank: manual transfer — no provider call needed

    await db.query(
      `INSERT INTO payments (id, order_id, method, ref, provider_ref, status, amount_tzs)
       VALUES ($1,$2,$3,$4,$5,'pending',$6)`,
      [uuidv4(), value.orderId, value.method, ref, providerRef, value.amount]
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
    const { rows } = await db.query('SELECT * FROM payments WHERE ref = $1', [req.params.ref]);
    if (!rows.length) return res.status(404).json({ error: 'Payment not found' });

    const payment = rows[0];

    // For Stripe: poll PaymentIntent status if still pending
    if (payment.method === 'card' && payment.status === 'pending' && payment.provider_ref) {
      try {
        const pi = await stripeService.confirmPayment(payment.provider_ref);
        if (pi.status === 'succeeded') {
          await db.query("UPDATE payments SET status='success',updated_at=NOW() WHERE ref=$1", [req.params.ref]);
          payment.status = 'success';
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

module.exports = router;
