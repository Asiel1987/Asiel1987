'use strict';

const express = require('express');
const Joi = require('joi');

const router = express.Router();
const db = require('../db');
const logger = require('../logger');
const { requireAuth, requireRole } = require('../middleware/auth');

// ── Validation schemas ────────────────────────────────────────────────────────

const listingSchema = Joi.object({
  name: Joi.string().min(2).max(200).required(),
  tzsPrice: Joi.number().integer().min(1).required().messages({
    'number.base': 'tzsPrice must be a positive integer',
  }),
  stockQty: Joi.number().integer().min(0).default(0),
  unit: Joi.string().max(20).default('KG'),
  country: Joi.string().valid('TZ', 'KE').required(),
  organic: Joi.boolean().default(false),
  hubReady: Joi.boolean().default(false),
  harvestDate: Joi.date().iso().optional().allow(null),
});

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /api/products?country=TZ&page=1&limit=20&organic=true&available=true
 * Returns paginated products filtered by country, joined with farmer name.
 */
router.get('/', async (req, res, next) => {
  try {
    const { country, organic, available, page = '1', limit = '20', search } = req.query;

    const conditions = [];
    const params = [];

    if (country) {
      params.push(country.toUpperCase());
      conditions.push(`p.country = $${params.length}`);
    }

    if (organic === 'true' || organic === '1') {
      conditions.push('p.organic = true');
    }

    // Default to showing only available products unless caller explicitly requests all
    const showAvailable = available !== 'false' && available !== '0';
    if (showAvailable) {
      conditions.push('p.available = true');
    }

    if (search) {
      params.push(`%${search}%`);
      conditions.push(`p.name ILIKE $${params.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * limitNum;

    params.push(limitNum);
    params.push(offset);

    const dataQuery = `
      SELECT
        p.id,
        p.name,
        p.tzs_price        AS "tzsPrice",
        p.stock_qty        AS "stockQty",
        p.unit,
        p.country,
        p.organic,
        p.hub_ready        AS "hubReady",
        p.harvest_date     AS "harvestDate",
        p.available,
        p.created_at       AS "createdAt",
        u.id               AS "farmerId",
        u.name             AS "farmerName"
      FROM products p
      LEFT JOIN users u ON u.id = p.farmer_id
      ${whereClause}
      ORDER BY p.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;

    // Count query (same filters, no pagination params)
    const countParams = params.slice(0, params.length - 2);
    const countQuery = `
      SELECT COUNT(*) AS total
      FROM products p
      ${whereClause}
    `;

    const [dataResult, countResult] = await Promise.all([
      db.query(dataQuery, params),
      db.query(countQuery, countParams),
    ]);

    const total = parseInt(countResult.rows[0].total, 10);

    return res.json({
      data: dataResult.rows,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/products/:id
 * Returns a single product with farmer details.
 */
router.get('/:id', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT
         p.id,
         p.name,
         p.tzs_price    AS "tzsPrice",
         p.stock_qty    AS "stockQty",
         p.unit,
         p.country,
         p.organic,
         p.hub_ready    AS "hubReady",
         p.harvest_date AS "harvestDate",
         p.available,
         p.created_at   AS "createdAt",
         u.id           AS "farmerId",
         u.name         AS "farmerName"
       FROM products p
       LEFT JOIN users u ON u.id = p.farmer_id
       WHERE p.id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    return res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/listings
 * Create a new product listing. Requires authenticated farmer role.
 */
router.post(
  '/listings',
  requireAuth,
  requireRole('farmer'),
  async (req, res, next) => {
    try {
      const { error, value } = listingSchema.validate(req.body);
      if (error) return next(error);

      const result = await db.query(
        `INSERT INTO products
           (farmer_id, name, tzs_price, stock_qty, unit, country, organic, hub_ready, harvest_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING
           id,
           name,
           tzs_price    AS "tzsPrice",
           stock_qty    AS "stockQty",
           unit,
           country,
           organic,
           hub_ready    AS "hubReady",
           harvest_date AS "harvestDate",
           available,
           created_at   AS "createdAt"`,
        [
          req.session.userId,
          value.name,
          value.tzsPrice,
          value.stockQty,
          value.unit,
          value.country,
          value.organic,
          value.hubReady,
          value.harvestDate || null,
        ]
      );

      const product = result.rows[0];

      logger.info('New product listing created', {
        productId: product.id,
        farmerId: req.session.userId,
        name: product.name,
        country: product.country,
      });

      return res.status(201).json(product);
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
