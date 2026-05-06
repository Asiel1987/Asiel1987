'use strict';

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

// Generate a 6-character alphanumeric code
function generateCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
}

// ── GET /api/referrals/my-code ─────────────────────────────────────────────────
// Returns the caller's referral code, creating one if it doesn't exist yet.
router.get('/my-code', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT referral_code FROM users WHERE id = $1',
      [req.session.userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });

    let code = rows[0].referral_code;
    if (!code) {
      // Generate a unique code (retry on collision, max 5 attempts)
      for (let i = 0; i < 5; i++) {
        code = generateCode();
        try {
          await db.query('UPDATE users SET referral_code = $1 WHERE id = $2', [code, req.session.userId]);
          break;
        } catch (err) {
          if (err.code === '23505') continue; // unique violation, retry
          throw err;
        }
      }
    }

    // Count successful referrals and pending
    const stats = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE reward_paid = TRUE)  AS paid,
         COUNT(*) FILTER (WHERE reward_paid = FALSE) AS pending,
         COALESCE(SUM(reward_tzs) FILTER (WHERE reward_paid = TRUE), 0) AS earned_tzs
       FROM referrals WHERE referrer_id = $1`,
      [req.session.userId]
    );

    res.json({ code, ...stats.rows[0] });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/referrals/use ────────────────────────────────────────────────────
// Called when a newly registered user enters a referral code.
// Links the referee to the referrer; reward is paid when referee makes first sale.
router.post('/use', requireAuth, async (req, res, next) => {
  try {
    const { code } = req.body;
    if (!code || typeof code !== 'string') return res.status(400).json({ error: 'code required' });

    // Find referrer
    const { rows: referrerRows } = await db.query(
      'SELECT id FROM users WHERE referral_code = $1',
      [code.toUpperCase().trim()]
    );
    if (!referrerRows.length) return res.status(404).json({ error: 'Invalid referral code' });

    const referrerId = referrerRows[0].id;
    const refereeId  = req.session.userId;

    if (String(referrerId) === String(refereeId)) {
      return res.status(400).json({ error: 'You cannot use your own referral code' });
    }

    // Check if this user was already referred
    const { rows: existing } = await db.query(
      'SELECT id FROM referrals WHERE referee_id = $1',
      [refereeId]
    );
    if (existing.length) return res.status(409).json({ error: 'Already used a referral code' });

    // Link referee to referrer
    await db.query(
      `INSERT INTO referrals (referrer_id, referee_id, reward_tzs)
       VALUES ($1, $2, 5000)`,
      [referrerId, refereeId]
    );
    await db.query(
      'UPDATE users SET referred_by_id = $1 WHERE id = $2',
      [referrerId, refereeId]
    );

    res.status(201).json({ ok: true, message: 'Referral code applied successfully' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
