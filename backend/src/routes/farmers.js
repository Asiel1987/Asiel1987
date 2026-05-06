'use strict';

const express         = require('express');
const Joi             = require('joi');
const db              = require('../db');
const logger          = require('../logger');
const redisClient     = require('../redis');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

const profileSchema = Joi.object({
  fullName:       Joi.string().min(2).max(100).required(),
  nationalId:     Joi.string().pattern(/^\d{8,20}$/).optional().allow(''),
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
  maxWeeklyKg:    Joi.number().integer().min(1).max(100000).required(),
  payoutMethod:   Joi.string().valid('mpesa','tigo','airtel','bank').required(),
  payoutPhone:    Joi.string().pattern(/^\+?[0-9]{9,15}$/).allow('').default(''),
});

// POST /api/farmers/profile — submit onboarding profile
router.post('/profile', requireAuth, requireRole('farmer'), async (req, res, next) => {
  try {
    const { error, value } = profileSchema.validate(req.body, { abortEarly: false });
    if (error) {
      return res.status(400).json({ error: error.details.map(d => d.message).join('; ') });
    }

    await db.query(
      `UPDATE users SET name = $1, updated_at = NOW() WHERE id = $2`,
      [value.fullName, req.session.userId]
    );

    // Store full profile in Redis (TTL 30 days); nationalId excluded from stored data
    const { nationalId: _nid, ...profileData } = value;
    await redisClient.set(
      `farmer:profile:${req.session.userId}`,
      JSON.stringify({ ...profileData, userId: req.session.userId, status: 'pending', createdAt: new Date().toISOString() }),
      'EX',
      30 * 24 * 3600
    );

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
    const raw = await redisClient.get(`farmer:profile:${req.session.userId}`);
    if (raw) {
      const profile = JSON.parse(raw);
      return res.json({ status: profile.status || 'pending' });
    }
    res.json({ status: 'not_submitted' });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/farmers/:userId/status — admin approves or rejects a farmer
router.patch('/:userId/status', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!['approved','rejected'].includes(status)) {
      return res.status(400).json({ error: 'status must be "approved" or "rejected"' });
    }

    const key = `farmer:profile:${req.params.userId}`;
    const raw = await redisClient.get(key);
    if (!raw) {
      return res.status(404).json({ error: 'Farmer profile not found' });
    }

    const profile = JSON.parse(raw);
    profile.status = status;
    profile.reviewedAt = new Date().toISOString();
    profile.reviewedBy = req.session.userId;

    await redisClient.set(key, JSON.stringify(profile), 'EX', 30 * 24 * 3600);

    if (status === 'approved') {
      await db.query(
        "UPDATE users SET role = 'farmer', updated_at = NOW() WHERE id = $1",
        [req.params.userId]
      );
    }

    logger.info('Farmer status updated by admin', {
      targetUserId: req.params.userId,
      status,
      adminId: req.session.userId,
    });

    res.json({ status });
  } catch (err) {
    next(err);
  }
});

// GET /api/farmers/pending — list pending farmer applications (admin only)
router.get('/pending', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    // Scan Redis for pending farmer profiles (pattern scan, acceptable for admin use)
    const keys = await redisClient.keys('farmer:profile:*');
    const pending = [];

    for (const key of keys) {
      const raw = await redisClient.get(key);
      if (!raw) continue;
      const profile = JSON.parse(raw);
      if (profile.status === 'pending') {
        pending.push({
          userId:    profile.userId,
          farmName:  profile.farmName,
          region:    profile.region,
          crops:     profile.crops,
          createdAt: profile.createdAt,
        });
      }
    }

    res.json({ pending });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
