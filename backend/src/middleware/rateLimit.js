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
 * otpSendLimiter
 * 5 requests per hour per IP — strict to prevent SMS billing abuse.
 */
const otpSendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many OTP requests. Please wait before requesting another code.' },
  store: new RedisStore({
    sendCommand: (...args) => redisClient.call(...args),
    prefix: 'rl:otp:send:',
  }),
});

/**
 * otpVerifyLimiter
 * 15 requests per hour per IP — more permissive than send since per-OTP
 * brute-force is already capped at 5 attempts in the auth handler.
 */
const otpVerifyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 15,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many verification attempts. Please try again later.' },
  store: new RedisStore({
    sendCommand: (...args) => redisClient.call(...args),
    prefix: 'rl:otp:verify:',
  }),
});

module.exports = { generalLimiter, otpSendLimiter, otpVerifyLimiter };
