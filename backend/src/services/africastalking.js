'use strict';

const AfricasTalking = require('africastalking');
const logger = require('../logger');

const at = AfricasTalking({
  username: process.env.AFRICASTALKING_USERNAME,
  apiKey: process.env.AFRICASTALKING_API_KEY,
});

const sms = at.SMS;

/**
 * Generate a cryptographically-safe 6-digit OTP.
 * Uses crypto.randomInt to avoid modulo bias.
 *
 * @returns {string} Six-digit zero-padded string e.g. "047823"
 */
function generateOTP() {
  // randomInt(min, max) — max is exclusive, so range is 0–999999
  const crypto = require('crypto');
  const code = crypto.randomInt(0, 1_000_000);
  return String(code).padStart(6, '0');
}

/**
 * Send an OTP code to a phone number via Africa's Talking SMS.
 *
 * @param {string} phone - E.164 phone number e.g. "+255712345678"
 * @param {string} code  - 6-digit OTP code
 * @returns {Promise<object>} Africa's Talking API response
 */
async function sendOTP(phone, code) {
  const message = `Your Asiel Farm Shop verification code is: ${code}. Valid for 10 minutes. Do not share this code.`;

  const options = {
    to: [phone],
    message,
    from: process.env.AFRICASTALKING_SENDER_ID || undefined,
  };

  logger.info('Sending OTP via Africa\'s Talking', { phone, senderID: options.from });

  const response = await sms.send(options);

  const recipient = response.SMSMessageData && response.SMSMessageData.Recipients
    ? response.SMSMessageData.Recipients[0]
    : null;

  if (recipient && recipient.status !== 'Success') {
    logger.warn('Africa\'s Talking SMS delivery issue', {
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
