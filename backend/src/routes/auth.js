'use strict';

const express = require('express');
const Joi     = require('joi');
const crypto  = require('crypto');
const axios   = require('axios');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();
const redisClient = require('../redis');
const db = require('../db');
const logger = require('../logger');
const { generateOTP, sendOTP } = require('../services/africastalking');
const { otpSendLimiter, otpVerifyLimiter } = require('../middleware/rateLimit');

// ── Social auth helpers ───────────────────────────────────────────────────────

async function verifyGoogleToken(credential) {
  const { data } = await axios.get('https://oauth2.googleapis.com/tokeninfo', {
    params: { id_token: credential },
    timeout: 8000,
  });
  if (data.aud !== process.env.GOOGLE_CLIENT_ID) {
    throw new Error('Google token audience mismatch');
  }
  if (parseInt(data.exp, 10) < Math.floor(Date.now() / 1000)) {
    throw new Error('Google token expired');
  }
  return {
    googleId:      data.sub,
    email:         data.email || null,
    emailVerified: data.email_verified === 'true',
    name:          data.name  || null,
  };
}

async function verifyAppleToken(idToken) {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('Invalid Apple JWT structure');

  const header  = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());

  if (payload.iss !== 'https://appleid.apple.com') throw new Error('Invalid Apple issuer');
  if (payload.aud !== process.env.APPLE_CLIENT_ID)  throw new Error('Apple token audience mismatch');
  if (payload.exp  < Math.floor(Date.now() / 1000)) throw new Error('Apple token expired');

  // Fetch Apple JWKS and verify RS256 signature using Node built-in crypto
  const { data } = await axios.get('https://appleid.apple.com/auth/keys', { timeout: 8000 });
  const jwk = data.keys.find(k => k.kid === header.kid && k.alg === header.alg);
  if (!jwk) throw new Error('No matching Apple public key');

  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const verifier  = crypto.createVerify('SHA256');
  verifier.update(`${parts[0]}.${parts[1]}`);
  if (!verifier.verify(publicKey, parts[2], 'base64url')) {
    throw new Error('Apple JWT signature invalid');
  }

  return {
    appleId:       payload.sub,
    email:         payload.email || null,
    emailVerified: payload.email_verified === true || payload.email_verified === 'true',
  };
}

// Finds an existing user by social ID, then email; links the social ID if found by email.
// Creates a new user (no phone) if no match found.
async function findOrCreateSocialUser({ provider, socialId, email, displayName }) {
  const idCol = provider === 'google' ? 'google_id' : 'apple_id';

  // 1) Lookup by social ID
  let result = await db.query(`SELECT * FROM users WHERE ${idCol} = $1`, [socialId]);
  if (result.rows.length) return result.rows[0];

  // 2) Lookup by email and link
  if (email) {
    result = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length) {
      const user = result.rows[0];
      await db.query(
        `UPDATE users SET ${idCol} = $1, display_name = COALESCE(display_name, $2), updated_at = NOW() WHERE id = $3`,
        [socialId, displayName, user.id]
      );
      return { ...user, [idCol]: socialId };
    }
  }

  // 3) Create new user (phone = NULL for social-only accounts)
  const inserted = await db.query(
    `INSERT INTO users (id, phone, email, ${idCol}, display_name, country)
     VALUES ($1, NULL, $2, $3, $4, 'TZ')
     RETURNING *`,
    [uuidv4(), email, socialId, displayName || null]
  );
  return inserted.rows[0];
}

async function createSocialSession(req, user) {
  await new Promise((resolve, reject) => {
    req.session.regenerate(err => (err ? reject(err) : resolve()));
  });
  req.session.userId  = user.id;
  req.session.role    = user.role;
  req.session.country = user.country;
}

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
router.post('/otp/send', otpSendLimiter, async (req, res, next) => {
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
router.post('/otp/verify', otpVerifyLimiter, async (req, res, next) => {
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

/**
 * POST /api/auth/google
 * Verify a Google Identity Services credential (ID token) and create a session.
 */
router.post('/google', async (req, res, next) => {
  try {
    const { credential } = req.body || {};
    if (!credential || typeof credential !== 'string') {
      return res.status(400).json({ error: 'Google credential is required' });
    }
    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.status(501).json({ error: 'Google sign-in is not configured on this server' });
    }

    let googleUser;
    try {
      googleUser = await verifyGoogleToken(credential);
    } catch (err) {
      logger.warn('Google token verification failed', { error: err.message });
      return res.status(401).json({ error: 'Google credential could not be verified' });
    }

    const user = await findOrCreateSocialUser({
      provider:    'google',
      socialId:    googleUser.googleId,
      email:       googleUser.email,
      displayName: googleUser.name,
    });

    await createSocialSession(req, user);

    logger.info('Google sign-in success', { userId: user.id, role: user.role });

    return res.json({
      success: true,
      role:    user.role,
      country: user.country,
      name:    user.display_name || user.name || null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/apple
 * Verify an Apple Sign In identity token and create a session.
 * `user` object (name/email) is only present on the very first authorization.
 */
router.post('/apple', async (req, res, next) => {
  try {
    const { idToken, user: appleUserInfo } = req.body || {};
    if (!idToken || typeof idToken !== 'string') {
      return res.status(400).json({ error: 'Apple id_token is required' });
    }
    if (!process.env.APPLE_CLIENT_ID) {
      return res.status(501).json({ error: 'Apple sign-in is not configured on this server' });
    }

    let applePayload;
    try {
      applePayload = await verifyAppleToken(idToken);
    } catch (err) {
      logger.warn('Apple token verification failed', { error: err.message });
      return res.status(401).json({ error: 'Apple identity token could not be verified' });
    }

    const displayName = appleUserInfo?.name
      ? `${appleUserInfo.name.firstName || ''} ${appleUserInfo.name.lastName || ''}`.trim() || null
      : null;

    const user = await findOrCreateSocialUser({
      provider:    'apple',
      socialId:    applePayload.appleId,
      email:       applePayload.email,
      displayName,
    });

    await createSocialSession(req, user);

    logger.info('Apple sign-in success', { userId: user.id, role: user.role });

    return res.json({
      success: true,
      role:    user.role,
      country: user.country,
      name:    user.display_name || user.name || null,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
