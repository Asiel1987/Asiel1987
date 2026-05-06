'use strict';

const express = require('express');
const Joi = require('joi');

const router = express.Router();
const db = require('../db');
const logger = require('../logger');
const { requireAuth } = require('../middleware/auth');

// ── Validation schemas ────────────────────────────────────────────────────────

const loyaltySchema = Joi.object({
  loyaltyPts: Joi.number().integer().min(0).required().messages({
    'number.base': 'loyaltyPts must be a non-negative integer',
  }),
});

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /api/users/me
 * Returns the full profile of the currently authenticated user.
 */
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT id, phone, role, country, loyalty_pts, name, created_at, updated_at
         FROM users
        WHERE id = $1`,
      [req.session.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];

    logger.debug('User profile fetched', { userId: user.id });

    return res.json({
      id: user.id,
      phone: user.phone,
      role: user.role,
      country: user.country,
      loyaltyPts: user.loyalty_pts,
      name: user.name,
      createdAt: user.created_at,
      updatedAt: user.updated_at,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/users/me/loyalty
 * Update the loyalty points balance for the authenticated user.
 * In practice this would be called internally by the order completion flow;
 * the endpoint is exposed here for admin tooling and testing.
 */
router.put('/me/loyalty', requireAuth, async (req, res, next) => {
  try {
    const { error, value } = loyaltySchema.validate(req.body);
    if (error) return next(error);

    const result = await db.query(
      `UPDATE users
          SET loyalty_pts = $1, updated_at = NOW()
        WHERE id = $2
        RETURNING id, loyalty_pts, updated_at`,
      [value.loyaltyPts, req.session.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    logger.info('Loyalty points updated', {
      userId: req.session.userId,
      loyaltyPts: value.loyaltyPts,
    });

    return res.json({
      id: result.rows[0].id,
      loyaltyPts: result.rows[0].loyalty_pts,
      updatedAt: result.rows[0].updated_at,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
