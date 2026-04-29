'use strict';

const Stripe = require('stripe');
const logger = require('../logger');

// Stripe expects amounts in the smallest currency unit (cents/fils).
// TZS and KES are both zero-decimal currencies in Stripe's system,
// so we pass the integer value directly (no x100 conversion).
// See: https://stripe.com/docs/currencies#zero-decimal
const ZERO_DECIMAL_CURRENCIES = ['TZS', 'KES', 'UGX', 'RWF'];

const stripe = Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
  appInfo: {
    name: 'Asiel Farm Shop',
    version: '1.0.0',
  },
});

/**
 * Create a Stripe PaymentIntent.
 *
 * @param {number} amountTZS  - Amount in TZS (integer)
 * @param {string} currency   - ISO 4217 currency code e.g. 'TZS', 'KES', 'USD'
 * @param {string} orderId    - Internal order UUID (stored in metadata)
 * @returns {Promise<{clientSecret: string, paymentIntentId: string}>}
 */
async function createPaymentIntent(amountTZS, currency, orderId) {
  const cur = (currency || 'TZS').toUpperCase();

  // For non-zero-decimal currencies multiply by 100 for cents
  const amount = ZERO_DECIMAL_CURRENCIES.includes(cur)
    ? Math.round(amountTZS)
    : Math.round(amountTZS * 100);

  logger.info('Creating Stripe PaymentIntent', { orderId, amount, currency: cur });

  const intent = await stripe.paymentIntents.create({
    amount,
    currency: cur.toLowerCase(),
    metadata: {
      orderId,
      platform: 'asiel-farm-shop',
    },
    automatic_payment_methods: { enabled: true },
  });

  logger.info('Stripe PaymentIntent created', {
    orderId,
    paymentIntentId: intent.id,
    status: intent.status,
  });

  return {
    clientSecret: intent.client_secret,
    paymentIntentId: intent.id,
    status: intent.status,
  };
}

/**
 * Retrieve a PaymentIntent and return its current status.
 *
 * @param {string} paymentIntentId - Stripe PaymentIntent ID (pi_xxx)
 * @returns {Promise<{paymentIntentId: string, status: string, amount: number, currency: string}>}
 */
async function confirmPayment(paymentIntentId) {
  logger.info('Retrieving Stripe PaymentIntent status', { paymentIntentId });

  const intent = await stripe.paymentIntents.retrieve(paymentIntentId);

  logger.info('Stripe PaymentIntent retrieved', {
    paymentIntentId: intent.id,
    status: intent.status,
  });

  return {
    paymentIntentId: intent.id,
    status: intent.status,
    amount: intent.amount,
    currency: intent.currency,
    metadata: intent.metadata,
  };
}

module.exports = { createPaymentIntent, confirmPayment };
