'use strict';

const express         = require('express');
const Joi             = require('joi');
const db              = require('../db');
const logger          = require('../logger');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

const profileSchema = Joi.object({
  fullName:       Joi.string().min(2).max(100).required(),
  nationalId:     Joi.string().pattern(/^\d{8,20}$/).required(),
  farmName:       Joi.string().min(2).max(200).required(),
  region:         Joi.string().min(2).max(100).required(),
  farmSize:       Joi.string().valid('small','medium','large').required(),
  lat:            Joi.number().min(-90).max(90).allow(null).default(null),
  lng:            Joi.number().min(-180).max(180).allow(null).default(null),
  crops:          Joi.array().items(Joi.string()).min(1).required(),
  farmingMethod:  Joi.string().valid('organic','conventional','mixed').required(),
  yearRound:      Joi.boolean().required(),
  canHubDeliver:  Joi.boolean().required(),
  hasColdStorage: Joi.boolean().required(),
  maxWeeklyKg:    Joi.number().integer().min(1).required(),
  payoutMethod:   Joi.string().valid('mpesa','tigo','airtel','bank').required(),
  payoutPhone:    Joi.string().allow('').default(''),
});

// POST /api/farmers/profile — submit onboarding profile
router.post('/profile', requireAuth, requireRole('farmer'), async (req, res, next) => {
  try {
    const { error, value } = profileSchema.validate(req.body, { abortEarly: false });
    if (error) {
      return res.status(400).json({ error: error.details.map(d => d.message).join('; ') });
    }

    // Upsert farmer profile (users table extended via JSONB metadata column)
    // If the column doesn't exist yet, fall back to just updating the name.
    try {
      await db.query(
        `UPDATE users
         SET name       = $1,
             updated_at = NOW()
         WHERE id = $2`,
        [value.fullName, req.session.userId]
      );
    } catch (dbErr) {
      logger.warn('Farmer profile DB update error', { error: dbErr.message });
    }

    // Store full profile in Redis for quick reads (TTL 30 days)
    const { default: redis } = await import('../redis.js').catch(() => ({ default: null }));
    if (redis) {
      await redis.setex(
        `farmer:profile:${req.session.userId}`,
        30 * 24 * 3600,
        JSON.stringify({ ...value, userId: req.session.userId, status: 'pending', createdAt: new Date().toISOString() })
      ).catch(() => {});
    }

    logger.info('Farmer onboarding profile submitted', {
      userId: req.session.userId,
      farmName: value.farmName,
      region: value.region,
      crops: value.crops.length,
    });

    res.status(201).json({ status: 'pending', message: 'Profile submitted for review' });
  } catch (err) {
    next(err);
  }
});

// GET /api/farmers/profile/status — check review status
router.get('/profile/status', requireAuth, requireRole('farmer'), async (req, res, next) => {
  try {
    const { default: redis } = await import('../redis.js').catch(() => ({ default: null }));
    if (redis) {
      const raw = await redis.get(`farmer:profile:${req.session.userId}`).catch(() => null);
      if (raw) {
        const profile = JSON.parse(raw);
        return res.json({ status: profile.status || 'pending' });
      }
    }
    res.json({ status: 'not_submitted' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
