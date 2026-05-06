'use strict';

const express = require('express');
const Joi = require('joi');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const addressSchema = Joi.object({
  nickname: Joi.string().max(40).required(),
  address:  Joi.string().max(500).required(),
  country:  Joi.string().valid('TZ', 'KE').required(),
  isDefault: Joi.boolean().default(false),
});

const MAX_ADDRESSES = 3;

// ── GET /api/addresses ────────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, nickname, address, country, is_default AS "isDefault", created_at AS "createdAt"
         FROM saved_addresses WHERE user_id = $1 ORDER BY is_default DESC, created_at ASC`,
      [req.session.userId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── POST /api/addresses ───────────────────────────────────────────────────────
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { error, value } = addressSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const { rows: existing } = await db.query(
      'SELECT COUNT(*) AS cnt FROM saved_addresses WHERE user_id = $1',
      [req.session.userId]
    );
    if (parseInt(existing[0].cnt, 10) >= MAX_ADDRESSES) {
      return res.status(422).json({ error: `Maximum ${MAX_ADDRESSES} saved addresses allowed` });
    }

    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      if (value.isDefault) {
        await client.query(
          'UPDATE saved_addresses SET is_default = FALSE WHERE user_id = $1',
          [req.session.userId]
        );
      }
      const { rows } = await client.query(
        `INSERT INTO saved_addresses (user_id, nickname, address, country, is_default)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, nickname, address, country, is_default AS "isDefault"`,
        [req.session.userId, value.nickname, value.address, value.country, value.isDefault]
      );
      await client.query('COMMIT');
      res.status(201).json(rows[0]);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (err) { next(err); }
});

// ── PATCH /api/addresses/:id/default ─────────────────────────────────────────
router.patch('/:id/default', requireAuth, async (req, res, next) => {
  try {
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE saved_addresses SET is_default = FALSE WHERE user_id = $1',
        [req.session.userId]
      );
      const { rowCount } = await client.query(
        'UPDATE saved_addresses SET is_default = TRUE WHERE id = $1 AND user_id = $2',
        [req.params.id, req.session.userId]
      );
      if (!rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (err) { next(err); }
});

// ── DELETE /api/addresses/:id ─────────────────────────────────────────────────
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const { rowCount } = await db.query(
      'DELETE FROM saved_addresses WHERE id = $1 AND user_id = $2',
      [req.params.id, req.session.userId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
