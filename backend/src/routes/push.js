'use strict';

const express = require('express');
const Joi = require('joi');
const router = express.Router();
const db = require('../db');
const logger = require('../logger');
const { requireAuth } = require('../middleware/auth');
const { vapidPublicKey } = require('../services/push');

// ── GET /api/push/vapid-public-key ────────────────────────────────────────────
// Returns the VAPID public key so the frontend can subscribe.
router.get('/vapid-public-key', (_req, res) => {
  if (!vapidPublicKey) return res.status(503).json({ error: 'Push not configured' });
  res.json({ key: vapidPublicKey });
});

const subscribeSchema = Joi.object({
  endpoint: Joi.string().uri().max(2048).required(),
  keys: Joi.object({
    p256dh: Joi.string().required(),
    auth:   Joi.string().required(),
  }).required(),
});

// ── POST /api/push/subscribe ──────────────────────────────────────────────────
// Saves a push subscription. Upserts so re-subscribing is idempotent.
router.post('/subscribe', requireAuth, async (req, res, next) => {
  try {
    const { error, value } = subscribeSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    await db.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, endpoint)
       DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
      [req.session.userId, value.endpoint, value.keys.p256dh, value.keys.auth]
    );

    logger.info('Push subscription saved', { userId: req.session.userId });
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/push/subscribe ────────────────────────────────────────────────
// Removes a push subscription on explicit opt-out.
router.delete('/subscribe', requireAuth, async (req, res, next) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
    await db.query(
      'DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2',
      [req.session.userId, endpoint]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
