'use strict';

/**
 * Africa's Talking SMS service — OTP delivery
 *
 * The AT SDK validates credentials at construction time, so we lazy-initialize
 * the client on first use. This keeps the module importable even when the env
 * vars are not yet set (e.g. during test runs that mock this module).
 */

const AfricasTalking = require('africastalking');
const crypto = require('crypto');
const logger = require('../logger');

// Lazy client — instantiated on first sendOTP() call
let _atClient = null;
let _sms = null;

function getATClient() {
  if (_atClient) return _sms;

  const username = process.env.AFRICASTALKING_USERNAME;
  const apiKey = process.env.AFRICASTALKING_API_KEY;

  if (!username || !apiKey) {
    throw new Error(
      'AFRICASTALKING_USERNAME and AFRICASTALKING_API_KEY must be set in the environment'
    );
  }

  _atClient = AfricasTalking({ username, apiKey });
  _sms = _atClient.SMS;
  return _sms;
}

/**
 * Generate a cryptographically-safe 6-digit OTP.
 * Uses crypto.randomInt to avoid modulo bias.
 *
 * @returns {string} Six-digit zero-padded string e.g. "047823"
 */
function generateOTP() {
  const code = crypto.randomInt(0, 1_000_000);
  return String(code).padStart(6, '0');
}

/**
 * Send a 6-digit OTP code to the given phone number via Africa's Talking SMS.
 *
 * @param {string} phone - E.164 phone number e.g. "+255712345678"
 * @param {string} code  - 6-digit OTP code produced by generateOTP()
 * @returns {Promise<object>} Africa's Talking API response object
 */
async function sendOTP(phone, code) {
  const sms = getATClient();

  const message =
    `Your Asiel Farm Shop verification code is: ${code}. ` +
    `Valid for 10 minutes. Do not share this code.`;

  const options = {
    to: [phone],
    message,
    from: process.env.AFRICASTALKING_SENDER_ID || undefined,
  };

  logger.info("Sending OTP via Africa's Talking", {
    phone,
    senderId: options.from || 'default',
  });

  const response = await sms.send(options);

  const recipient =
    response.SMSMessageData && response.SMSMessageData.Recipients
      ? response.SMSMessageData.Recipients[0]
      : null;

  if (recipient && recipient.status !== 'Success') {
    logger.warn("Africa's Talking SMS delivery issue", {
      phone,
      status: recipient.status,
      statusCode: recipient.statusCode,
    });
  } else {
    logger.info('OTP SMS sent successfully', {
      phone,
      messageId: recipient ? recipient.messageId : null,
    });
  }

  return response;
}

module.exports = { generateOTP, sendOTP };
