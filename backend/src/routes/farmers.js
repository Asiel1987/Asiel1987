'use strict';

const express         = require('express');
const Joi             = require('joi');
const db              = require('../db');
const logger          = require('../logger');
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

// POST /api/farmers/profile — submit or update onboarding profile
router.post('/profile', requireAuth, requireRole('farmer'), async (req, res, next) => {
  try {
    const { error, value } = profileSchema.validate(req.body, { abortEarly: false });
    if (error) {
      return res.status(400).json({ error: error.details.map(d => d.message).join('; ') });
    }

    // nationalId is collected for identity verification but not stored
    const { nationalId: _nid, ...profile } = value;

    await db.query(
      `UPDATE users SET name = $1, updated_at = NOW() WHERE id = $2`,
      [profile.fullName, req.session.userId]
    );

    await db.query(
      `INSERT INTO farmer_profiles
         (user_id, full_name, farm_name, region, farm_size, lat, lng, crops,
          farming_method, year_round, can_hub_deliver, has_cold_storage,
          max_weekly_kg, payout_method, payout_phone, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'pending')
       ON CONFLICT (user_id) DO UPDATE SET
         full_name        = EXCLUDED.full_name,
         farm_name        = EXCLUDED.farm_name,
         region           = EXCLUDED.region,
         farm_size        = EXCLUDED.farm_size,
         lat              = EXCLUDED.lat,
         lng              = EXCLUDED.lng,
         crops            = EXCLUDED.crops,
         farming_method   = EXCLUDED.farming_method,
         year_round       = EXCLUDED.year_round,
         can_hub_deliver  = EXCLUDED.can_hub_deliver,
         has_cold_storage = EXCLUDED.has_cold_storage,
         max_weekly_kg    = EXCLUDED.max_weekly_kg,
         payout_method    = EXCLUDED.payout_method,
         payout_phone     = EXCLUDED.payout_phone,
         status           = 'pending',
         reviewed_by      = NULL,
         reviewed_at      = NULL,
         updated_at       = NOW()`,
      [
        req.session.userId,
        profile.fullName,
        profile.farmName,
        profile.region,
        profile.farmSize,
        profile.lat,
        profile.lng,
        profile.crops,
        profile.farmingMethod,
        profile.yearRound,
        profile.canHubDeliver,
        profile.hasColdStorage,
        profile.maxWeeklyKg,
        profile.payoutMethod,
        profile.payoutPhone,
      ]
    );

    logger.info('Farmer onboarding profile submitted', {
      userId: req.session.userId,
      farmName: profile.farmName,
      region: profile.region,
      crops: profile.crops.length,
    });

    res.status(201).json({ status: 'pending', message: 'Profile submitted for review' });
  } catch (err) {
    next(err);
  }
});

// GET /api/farmers/profile/status — check own review status
router.get('/profile/status', requireAuth, requireRole('farmer'), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT status FROM farmer_profiles WHERE user_id = $1',
      [req.session.userId]
    );
    res.json({ status: rows[0]?.status || 'not_submitted' });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/farmers/:userId/status — admin approves or rejects a farmer
router.patch('/:userId/status', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'status must be "approved" or "rejected"' });
    }

    const { rowCount } = await db.query(
      `UPDATE farmer_profiles
          SET status      = $1,
              reviewed_by = $2,
              reviewed_at = NOW()
        WHERE user_id = $3`,
      [status, req.session.userId, req.params.userId]
    );
    if (!rowCount) {
      return res.status(404).json({ error: 'Farmer profile not found' });
    }

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
    const { rows } = await db.query(
      `SELECT user_id AS "userId", farm_name AS "farmName", region, crops, created_at AS "createdAt"
         FROM farmer_profiles
        WHERE status = 'pending'
        ORDER BY created_at ASC`
    );
    res.json({ pending: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
