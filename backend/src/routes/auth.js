'use strict';

const express = require('express');
const Joi = require('joi');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();
const redisClient = require('../redis');
const db = require('../db');
const logger = require('../logger');
const { generateOTP, sendOTP } = require('../services/africastalking');
const { otpLimiter } = require('../middleware/rateLimit');

// ── Validation schemas ────────────────────────────────────────────────────────

const sendSchema = Joi.object({
  phone: Joi.string()
    .pattern(/^\+[1-9]\d{6,14}$/)
    .required()
    .messages({
      'string.pattern.base': 'Phone must be in E.164 format e.g. +255712345678',
    }),
});

const verifySchema = Joi.object({
  phone: Joi.string()
    .pattern(/^\+[1-9]\d{6,14}$/)
    .required(),
  code: Joi.string()
    .length(6)
    .pattern(/^\d{6}$/)
    .required()
    .messages({
      'string.length': 'OTP must be exactly 6 digits',
      'string.pattern.base': 'OTP must be numeric',
    }),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function otpRedisKey(phone) {
  return `otp:${phone}`;
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * POST /api/auth/otp/send
 * Validate phone, generate OTP, store in Redis with 10-min TTL, send via AT SMS.
 */
router.post('/otp/send', otpLimiter, async (req, res, next) => {
  try {
    const { error, value } = sendSchema.validate(req.body);
    if (error) return next(error);

    const { phone } = value;
    const code = generateOTP();
    const key = otpRedisKey(phone);

    // Store code with 10-minute expiry; also store attempt count for brute-force protection
    const payload = JSON.stringify({ code, attempts: 0, createdAt: Date.now() });
    await redisClient.set(key, payload, 'EX', 600); // 600 seconds = 10 minutes

    await sendOTP(phone, code);

    logger.info('OTP sent', { phone });

    return res.status(200).json({ success: true, message: 'OTP sent to your phone number' });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/otp/verify
 * Compare submitted code with Redis value. On match, upsert user, create session.
 */
router.post('/otp/verify', otpLimiter, async (req, res, next) => {
  try {
    const { error, value } = verifySchema.validate(req.body);
    if (error) return next(error);

    const { phone, code } = value;
    const key = otpRedisKey(phone);

    const raw = await redisClient.get(key);
    if (!raw) {
      return res.status(400).json({ error: 'OTP expired or not found. Please request a new code.' });
    }

    let stored;
    try {
      stored = JSON.parse(raw);
    } catch {
      return res.status(400).json({ error: 'Invalid OTP session. Please request a new code.' });
    }

    // Brute-force guard: max 5 attempts per OTP
    if (stored.attempts >= 5) {
      await redisClient.del(key);
      return res.status(429).json({ error: 'Too many incorrect attempts. Please request a new code.' });
    }

    if (stored.code !== code) {
      stored.attempts += 1;
      await redisClient.set(key, JSON.stringify(stored), 'KEEPTTL');
      logger.warn('OTP mismatch', { phone, attempts: stored.attempts });
      return res.status(400).json({
        error: 'Incorrect OTP',
        attemptsRemaining: Math.max(0, 5 - stored.attempts),
      });
    }

    // Code matches — delete it so it cannot be reused
    await redisClient.del(key);

    // Determine country from phone prefix
    const country = phone.startsWith('+254') ? 'KE' : 'TZ';

    // Upsert user (create if first login, otherwise fetch existing row)
    const upsertResult = await db.query(
      `INSERT INTO users (id, phone, country)
         VALUES ($1, $2, $3)
       ON CONFLICT (phone) DO UPDATE
         SET updated_at = NOW()
       RETURNING id, phone, role, country, loyalty_pts, name, created_at`,
      [uuidv4(), phone, country]
    );

    const user = upsertResult.rows[0];

    // Regenerate session to prevent session fixation
    await new Promise((resolve, reject) => {
      req.session.regenerate((err) => (err ? reject(err) : resolve()));
    });

    req.session.userId = user.id;
    req.session.role = user.role;
    req.session.country = user.country;

    logger.info('User authenticated', { userId: user.id, role: user.role, country: user.country });

    return res.status(200).json({
      success: true,
      role: user.role,
      country: user.country,
      name: user.name,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/logout
 * Destroy session and clear the session cookie.
 */
router.post('/logout', async (req, res, next) => {
  try {
    const userId = req.session.userId;

    await new Promise((resolve, reject) => {
      req.session.destroy((err) => (err ? reject(err) : resolve()));
    });

    // Clear the session cookie from the browser
    res.clearCookie('asf_sid', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
    });

    logger.info('User logged out', { userId });

    return res.status(200).json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
