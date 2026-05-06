'use strict';

const { rateLimit } = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const redisClient = require('../redis');

/**
 * generalLimiter
 * 100 requests per 15 minutes per IP.
 * Applied globally in index.js.
 */
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 minutes
  max: 100,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
  store: new RedisStore({
    sendCommand: (...args) => redisClient.call(...args),
    prefix: 'rl:general:',
  }),
});

/**
 * otpLimiter
 * 5 requests per hour per IP — stricter limit for OTP send endpoint
 * to prevent SMS abuse and billing exploitation.
 */
const otpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,   // 1 hour
  max: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many OTP requests. Please wait before requesting another code.' },
  store: new RedisStore({
    sendCommand: (...args) => redisClient.call(...args),
    prefix: 'rl:otp:',
  }),
});

module.exports = { generalLimiter, otpLimiter };
