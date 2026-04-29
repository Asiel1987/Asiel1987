'use strict';

/**
 * Selcom USSD Push — Tanzania mobile money aggregator
 *
 * Selcom acts as an aggregator for TigoPesa, M-Pesa TZ, Airtel Money TZ,
 * Halopesa and Azam. A single API call reaches all TZ wallets.
 *
 * Docs: https://developers.selcommobile.com
 *
 * Auth: HMAC-SHA256 signature of the request body using the API secret.
 * Header format: "SELCOM <api_key>:<signature>"
 */

const axios = require('axios');
const crypto = require('crypto');
const logger = require('../logger');

const BASE_URL = process.env.SELCOM_API_URL || 'https://apigw.selcommobile.com/v1';
const API_KEY = process.env.SELCOM_API_KEY;
const API_SECRET = process.env.SELCOM_API_SECRET;
const VENDOR = process.env.SELCOM_VENDOR;

/**
 * Build the HMAC-SHA256 authorization header required by Selcom.
 *
 * @param {object} body - Request body object (will be JSON-stringified)
 * @returns {string} Authorization header value
 */
function buildAuthHeader(body) {
  const timestamp = new Date().toISOString();
  const bodyString = JSON.stringify(body);
  const digest = crypto
    .createHmac('sha256', API_SECRET)
    .update(`${timestamp}${bodyString}`)
    .digest('base64');

  return {
    Authorization: `SELCOM ${API_KEY}:${digest}`,
    'Digest-Method': 'HS256',
    Timestamp: timestamp,
    'Content-Type': 'application/json',
  };
}

/**
 * Initiate a Selcom USSD Push payment request.
 * The customer receives a USSD prompt on their phone to confirm payment.
 *
 * @param {string} phone    - Customer phone in E.164 format e.g. "+255712345678"
 * @param {number} amount   - Amount in TZS (integer)
 * @param {string} orderId  - Internal order UUID
 * @param {string} ref      - Unique payment reference (UUID)
 * @returns {Promise<{transactionId: string, reference: string}>}
 */
async function initiatePush(phone, amount, orderId, ref) {
  const body = {
    vendor: VENDOR,
    pin: 'SELCOM',             // replaced by USSD PIN on customer's phone
    buyer_msisdn: phone.replace(/^\+/, ''),  // Selcom wants numbers without leading +
    amount: String(Math.round(amount)),
    currency: 'TZS',
    order_id: ref,
    buyer_name: 'Asiel Customer',
    buyer_email: '',
    due_date: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30 min window
    payment_purpose: `Order ${orderId}`,
    no_of_items: 1,
    header_colour: '#1B8A2D',
    callback_url: `${process.env.FRONTEND_URL || 'https://yourdomain.com'}/api/payments/selcom/callback`,
    cancel_url: `${process.env.FRONTEND_URL || 'https://yourdomain.com'}/payment-cancelled`,
    billing_address: 'Tanzania',
    shipping_address: 'Tanzania',
  };

  const headers = buildAuthHeader(body);

  logger.info('Initiating Selcom USSD Push', { orderId, ref, amount });

  const response = await axios.post(`${BASE_URL}/checkout/create-order-minimal`, body, {
    headers,
    timeout: 15000,
  });

  if (response.data.resultcode !== '000') {
    const msg = `Selcom error: ${response.data.result} — ${response.data.message}`;
    logger.error('Selcom push failed', { orderId, ref, response: response.data });
    throw new Error(msg);
  }

  const transactionId = response.data.data && response.data.data[0]
    ? response.data.data[0].transid
    : ref;

  logger.info('Selcom USSD Push initiated', { orderId, ref, transactionId });

  return { transactionId, reference: ref };
}

/**
 * Query the status of a Selcom payment by order reference.
 *
 * @param {string} ref - Payment reference UUID
 * @returns {Promise<{status: string, transactionId: string|null}>}
 */
async function queryStatus(ref) {
  const body = { order_id: ref, vendor: VENDOR };
  const headers = buildAuthHeader(body);

  logger.info('Querying Selcom payment status', { ref });

  const response = await axios.post(`${BASE_URL}/checkout/order-status`, body, {
    headers,
    timeout: 10000,
  });

  const data = response.data.data && response.data.data[0] ? response.data.data[0] : {};

  return {
    status: (data.payment_status || 'unknown').toLowerCase(),
    transactionId: data.transid || null,
    selcomStatus: data.payment_status,
  };
}

module.exports = { initiatePush, queryStatus };
