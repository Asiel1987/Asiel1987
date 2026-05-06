'use strict';

/**
 * M-Pesa Kenya — Safaricom Daraja API
 *
 * Lipa Na M-Pesa Online (STK Push) allows us to prompt the customer
 * to enter their M-Pesa PIN on their phone to complete payment.
 *
 * Daraja docs: https://developer.safaricom.co.ke/APIs/MpesaExpressSimulate
 */

const axios = require('axios');
const logger = require('../logger');

const IS_SANDBOX = (process.env.MPESA_ENV || 'sandbox') === 'sandbox';
const DARAJA_BASE = IS_SANDBOX
  ? 'https://sandbox.safaricom.co.ke'
  : 'https://api.safaricom.co.ke';

const CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY;
const CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET;
const SHORTCODE = process.env.MPESA_SHORTCODE;
const PASSKEY = process.env.MPESA_PASSKEY;
const CALLBACK_URL = process.env.MPESA_CALLBACK_URL;

// In-memory token cache — avoids fetching a new token for every request.
// Tokens are valid for 1 hour; we refresh 2 minutes early.
let _tokenCache = null;
let _tokenExpiresAt = 0;

/**
 * Fetch (or return cached) Daraja OAuth access token.
 *
 * @returns {Promise<string>} Bearer token
 */
async function getAccessToken() {
  if (_tokenCache && Date.now() < _tokenExpiresAt) {
    return _tokenCache;
  }

  const credentials = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');

  const response = await axios.get(
    `${DARAJA_BASE}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: { Authorization: `Basic ${credentials}` },
      timeout: 10000,
    }
  );

  const { access_token, expires_in } = response.data;
  _tokenCache = access_token;
  _tokenExpiresAt = Date.now() + (parseInt(expires_in, 10) - 120) * 1000; // refresh 2 min early

  logger.info('M-Pesa Daraja access token refreshed');

  return access_token;
}

/**
 * Build the Lipa Na M-Pesa password.
 * Format: base64(Shortcode + Passkey + Timestamp)
 *
 * @param {string} timestamp - YYYYMMDDHHmmss
 * @returns {string} Base64 password
 */
function buildPassword(timestamp) {
  return Buffer.from(`${SHORTCODE}${PASSKEY}${timestamp}`).toString('base64');
}

/**
 * Format a date as YYYYMMDDHHmmss (Daraja timestamp format).
 *
 * @returns {string}
 */
function getTimestamp() {
  return new Date()
    .toISOString()
    .replace(/[-T:.Z]/g, '')
    .slice(0, 14);
}

/**
 * Initiate an STK Push request to the customer's M-Pesa wallet.
 *
 * @param {string} phone   - Customer phone in E.164 format e.g. "+254712345678"
 * @param {number} amount  - Amount in KES (integer)
 * @param {string} orderId - Internal order UUID (stored in AccountReference)
 * @param {string} ref     - Unique payment reference (UUID)
 * @returns {Promise<{CheckoutRequestID: string, MerchantRequestID: string}>}
 */
async function initiateSTKPush(phone, amount, orderId, ref) {
  const token = await getAccessToken();
  const timestamp = getTimestamp();
  const password = buildPassword(timestamp);

  // Daraja requires the phone in the format 2547XXXXXXXX (no leading +)
  const msisdn = phone.replace(/^\+/, '');

  const body = {
    BusinessShortCode: SHORTCODE,
    Password: password,
    Timestamp: timestamp,
    TransactionType: 'CustomerPayBillOnline',
    Amount: Math.round(amount),
    PartyA: msisdn,
    PartyB: SHORTCODE,
    PhoneNumber: msisdn,
    CallBackURL: CALLBACK_URL,
    AccountReference: ref,
    TransactionDesc: `Asiel Farm Shop Order ${orderId}`,
  };

  logger.info('Initiating M-Pesa STK Push', { orderId, ref, amount, msisdn });

  const response = await axios.post(
    `${DARAJA_BASE}/mpesa/stkpush/v1/processrequest`,
    body,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  );

  const { ResponseCode, ResponseDescription, MerchantRequestID, CheckoutRequestID } = response.data;

  if (ResponseCode !== '0') {
    logger.error('M-Pesa STK Push failed', {
      orderId,
      ref,
      ResponseCode,
      ResponseDescription,
    });
    throw new Error(`M-Pesa error: ${ResponseDescription}`);
  }

  logger.info('M-Pesa STK Push initiated', { orderId, ref, CheckoutRequestID });

  return { CheckoutRequestID, MerchantRequestID };
}

/**
 * Query the status of an STK Push request.
 *
 * @param {string} checkoutRequestId - CheckoutRequestID from initiateSTKPush
 * @returns {Promise<{ResultCode: string, ResultDesc: string}>}
 */
async function querySTKStatus(checkoutRequestId) {
  const token = await getAccessToken();
  const timestamp = getTimestamp();
  const password = buildPassword(timestamp);

  const body = {
    BusinessShortCode: SHORTCODE,
    Password: password,
    Timestamp: timestamp,
    CheckoutRequestID: checkoutRequestId,
  };

  logger.info('Querying M-Pesa STK status', { checkoutRequestId });

  const response = await axios.post(
    `${DARAJA_BASE}/mpesa/stkpushquery/v1/query`,
    body,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    }
  );

  return {
    ResultCode: response.data.ResultCode,
    ResultDesc: response.data.ResultDesc,
    raw: response.data,
  };
}

module.exports = { initiateSTKPush, querySTKStatus };
