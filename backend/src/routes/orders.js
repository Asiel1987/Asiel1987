'use strict';

const express = require('express');
const Joi = require('joi');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();
const db = require('../db');
const redisClient = require('../redis');
const logger = require('../logger');
const { requireAuth } = require('../middleware/auth');
const { broadcast } = require('./events');
const { sendPush } = require('../services/push');

// ── Validation schemas ────────────────────────────────────────────────────────

const orderItemSchema = Joi.object({
  productId: Joi.string().uuid().required(),
  qty: Joi.number().integer().min(1).required(),
});

const createOrderSchema = Joi.object({
  country: Joi.string().valid('TZ', 'KE').required(),
  deliveryAddress: Joi.string().max(500).required(),
  items: Joi.array().items(orderItemSchema).min(1).required(),
  deliveryFee: Joi.number().integer().min(0).default(0),
  discount: Joi.number().integer().min(0).default(0),
  loyaltyPtsRedeem: Joi.number().integer().min(0).default(0),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a WHERE clause and params array based on the user's role.
 * Ensures each role can only see the orders they are supposed to.
 */
function buildOrderFilter(role, userId, country, existingParams = []) {
  const conditions = [];
  const params = [...existingParams];

  if (role === 'customer') {
    params.push(userId);
    conditions.push(`o.customer_id = $${params.length}`);
  } else if (role === 'rider') {
    params.push(userId);
    conditions.push(`o.rider_id = $${params.length}`);
  } else if (role === 'farmer') {
    // Farmers see orders that contain at least one of their products
    params.push(userId);
    conditions.push(`EXISTS (
      SELECT 1 FROM order_items oi
      JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = o.id AND p.farmer_id = $${params.length}
    )`);
  }
  // 'admin' sees all — no extra condition

  if (country) {
    params.push(country.toUpperCase());
    conditions.push(`o.country = $${params.length}`);
  }

  return { conditions, params };
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /api/orders?country=TZ&status=pending&page=1&limit=20
 * Role-filtered order list.
 */
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { country, status, page = '1', limit = '20' } = req.query;
    const { role, userId } = req.session;

    const { conditions, params } = buildOrderFilter(role, userId, country);

    if (status) {
      params.push(status);
      conditions.push(`o.status = $${params.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * limitNum;

    params.push(limitNum, offset);

    const dataQuery = `
      SELECT
        o.id,
        o.status,
        o.total_tzs      AS "totalTzs",
        o.delivery_fee   AS "deliveryFee",
        o.discount,
        o.country,
        o.delivery_address AS "deliveryAddress",
        o.created_at     AS "createdAt",
        o.updated_at     AS "updatedAt",
        c.name           AS "customerName",
        c.phone          AS "customerPhone",
        r.name           AS "riderName"
      FROM orders o
      LEFT JOIN users c ON c.id = o.customer_id
      LEFT JOIN users r ON r.id = o.rider_id
      ${whereClause}
      ORDER BY o.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;

    const countParams = params.slice(0, params.length - 2);
    const countQuery = `SELECT COUNT(*) AS total FROM orders o ${whereClause}`;

    const [dataResult, countResult] = await Promise.all([
      db.query(dataQuery, params),
      db.query(countQuery, countParams),
    ]);

    return res.json({
      data: dataResult.rows,
      pagination: {
        total: parseInt(countResult.rows[0].total, 10),
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(parseInt(countResult.rows[0].total, 10) / limitNum),
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/orders
 * Create a new order in a transaction: insert order, insert items, decrement stock.
 */
router.post('/', requireAuth, async (req, res, next) => {
  const client = await db.getClient();
  try {
    const { error, value } = createOrderSchema.validate(req.body);
    if (error) return next(error);

    await client.query('BEGIN');

    // Lock the user row first (before product locks) to establish a consistent
    // lock order and prevent deadlocks with concurrent loyalty-point operations.
    const userLockResult = await client.query(
      'SELECT loyalty_pts FROM users WHERE id = $1 FOR UPDATE',
      [req.session.userId]
    );
    if (!userLockResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(401).json({ error: 'User not found' });
    }
    const currentLoyaltyPts = userLockResult.rows[0].loyalty_pts || 0;

    // Fetch all products in one query and lock the rows for the stock update
    const productIds = value.items.map((i) => i.productId);
    const productResult = await client.query(
      `SELECT id, tzs_price, stock_qty, available, country
         FROM products
        WHERE id = ANY($1::uuid[])
        FOR UPDATE`,
      [productIds]
    );

    const productMap = new Map(productResult.rows.map((p) => [p.id, p]));

    // Validate each item: product exists, available, in-country, enough stock
    for (const item of value.items) {
      const product = productMap.get(item.productId);
      if (!product) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Product ${item.productId} not found` });
      }
      if (!product.available) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Product ${item.productId} is not available` });
      }
      if (product.country !== value.country) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `Product ${item.productId} is not available in country ${value.country}`,
        });
      }
      if (product.stock_qty < item.qty) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `Insufficient stock for product ${item.productId}`,
          available: product.stock_qty,
          requested: item.qty,
        });
      }
    }

    // Calculate total
    let totalTzs = value.items.reduce((sum, item) => {
      const product = productMap.get(item.productId);
      return sum + product.tzs_price * item.qty;
    }, 0);

    totalTzs = totalTzs + value.deliveryFee - value.discount;
    totalTzs = Math.max(0, totalTzs);

    // Apply loyalty points redemption to the chargeable amount upfront so the
    // payment processor is charged the correct net figure, not the gross total.
    const loyaltyDiscount = Math.min(value.loyaltyPtsRedeem, totalTzs);
    const chargeableTzs = totalTzs - loyaltyDiscount;

    // Insert order — total_tzs is the gross amount; charged_tzs is after loyalty discount
    const orderId = uuidv4();
    await client.query(
      `INSERT INTO orders
         (id, customer_id, status, total_tzs, charged_tzs, delivery_fee, discount, country, delivery_address)
       VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7, $8)`,
      [
        orderId,
        req.session.userId,
        totalTzs,
        chargeableTzs,
        value.deliveryFee,
        value.discount,
        value.country,
        value.deliveryAddress,
      ]
    );

    // Insert order items and decrement stock
    for (const item of value.items) {
      const product = productMap.get(item.productId);
      await client.query(
        `INSERT INTO order_items (id, order_id, product_id, qty, tzs_price)
         VALUES ($1, $2, $3, $4, $5)`,
        [uuidv4(), orderId, item.productId, item.qty, product.tzs_price]
      );

      await client.query(
        `UPDATE products
            SET stock_qty = stock_qty - $1,
                available  = CASE WHEN stock_qty - $1 <= 0 THEN false ELSE available END
          WHERE id = $2`,
        [item.qty, item.productId]
      );
    }

    // Deduct loyalty points — user row already locked above; use the prefetched value
    if (loyaltyDiscount > 0) {
      if (loyaltyDiscount > currentLoyaltyPts) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'Insufficient loyalty points',
          available: currentLoyaltyPts,
          requested: loyaltyDiscount,
        });
      }
      await client.query(
        'UPDATE users SET loyalty_pts = loyalty_pts - $1, updated_at = NOW() WHERE id = $2',
        [loyaltyDiscount, req.session.userId]
      );
    }

    await client.query('COMMIT');

    logger.info('Order created', {
      orderId,
      customerId: req.session.userId,
      totalTzs,
      country: value.country,
      itemCount: value.items.length,
    });

    return res.status(201).json({ id: orderId, totalTzs, chargeableTzs, status: 'pending' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

/**
 * GET /api/orders/:id
 * Return a single order with its items.
 * Applies the same role-based access control as the list endpoint.
 */
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const { role, userId } = req.session;
    const { id } = req.params;

    // Fetch the order first to check access
    const orderResult = await db.query(
      `SELECT
         o.id,
         o.customer_id   AS "customerId",
         o.rider_id      AS "riderId",
         o.status,
         o.total_tzs     AS "totalTzs",
         o.delivery_fee  AS "deliveryFee",
         o.discount,
         o.country,
         o.delivery_address AS "deliveryAddress",
         o.created_at    AS "createdAt",
         o.updated_at    AS "updatedAt",
         c.name          AS "customerName",
         c.phone         AS "customerPhone",
         r.name          AS "riderName"
       FROM orders o
       LEFT JOIN users c ON c.id = o.customer_id
       LEFT JOIN users r ON r.id = o.rider_id
       WHERE o.id = $1`,
      [id]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderResult.rows[0];

    // Role-based access check
    if (role === 'customer' && order.customerId !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (role === 'rider' && order.riderId !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (role === 'farmer') {
      // Check if any item in this order belongs to this farmer
      const farmerCheck = await db.query(
        `SELECT 1 FROM order_items oi
           JOIN products p ON p.id = oi.product_id
          WHERE oi.order_id = $1 AND p.farmer_id = $2
          LIMIT 1`,
        [id, userId]
      );
      if (farmerCheck.rows.length === 0) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    // Fetch order items
    const itemsResult = await db.query(
      `SELECT
         oi.id,
         oi.qty,
         oi.tzs_price    AS "tzsPrice",
         p.id            AS "productId",
         p.name          AS "productName",
         p.unit,
         u.id            AS "farmerId",
         u.name          AS "farmerName"
       FROM order_items oi
       JOIN products p ON p.id = oi.product_id
       LEFT JOIN users u ON u.id = p.farmer_id
       WHERE oi.order_id = $1
       ORDER BY oi.id`,
      [id]
    );

    return res.json({ ...order, items: itemsResult.rows });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/orders/:id/status ───────────────────────────────────────────
// Riders update order status; admins can update any order.
// Fires push notifications at three key customer moments.
const statusSchema = Joi.object({
  status:  Joi.string().valid('assigned', 'picked-up', 'delivered', 'cancelled').required(),
  riderId: Joi.string().uuid().optional(),  // required when assigning
});

// Valid transitions per role.  '*' means any current status is acceptable.
const ALLOWED_TRANSITIONS = {
  rider: {
    'picked-up': ['assigned'],
    delivered:   ['picked-up'],
  },
  admin: {
    assigned:    ['pending', 'assigned'],
    'picked-up': ['assigned'],
    delivered:   ['picked-up'],
    cancelled:   ['pending', 'assigned', 'picked-up'],
  },
};

function isTransitionAllowed(role, currentStatus, targetStatus) {
  const map = ALLOWED_TRANSITIONS[role] || {};
  const allowed = map[targetStatus];
  if (!allowed) return false;
  return allowed.includes(currentStatus);
}

const PUSH_MESSAGES = {
  assigned:   { title: '🛵 Rider on the way!',        body: 'Your order has been accepted and a rider is heading to pick it up.' },
  'picked-up':{ title: '📦 Order picked up',           body: 'Your order is now on its way — rider is heading to you!' },
  delivered:  { title: '✅ Order delivered!',           body: 'Enjoy your fresh produce. Leave a review to help other shoppers.' },
};

router.patch('/:id/status', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { error, value } = statusSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const { rows } = await db.query(
      'SELECT customer_id, rider_id, status FROM orders WHERE id = $1',
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Order not found' });

    const order = rows[0];
    const isRider = String(order.rider_id) === String(req.session.userId);
    const isAdmin = req.session.role === 'admin';
    if (!isRider && !isAdmin) return res.status(403).json({ error: 'Forbidden' });

    // Validate state machine transition
    const actorRole = isAdmin ? 'admin' : 'rider';
    if (!isTransitionAllowed(actorRole, order.status, value.status)) {
      return res.status(422).json({
        error: `Cannot transition order from '${order.status}' to '${value.status}'`,
      });
    }

    // Build update — optionally set rider_id when assigning
    let updateQuery, params;
    if (value.status === 'assigned' && value.riderId) {
      updateQuery = 'UPDATE orders SET status = $1, rider_id = $2, updated_at = NOW() WHERE id = $3';
      params = [value.status, value.riderId, id];
    } else {
      updateQuery = 'UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2';
      params = [value.status, id];
    }
    await db.query(updateQuery, params);

    // Broadcast SSE to all connected clients
    broadcast(String(order.customer_id), 'order_update', { id, status: value.status });

    // Push notification to customer at three key moments
    const pushMsg = PUSH_MESSAGES[value.status];
    if (pushMsg) {
      sendPush(String(order.customer_id), pushMsg.title, pushMsg.body, {
        orderId: id,
        status: value.status,
        url: `/?order=${id}`,
      }).catch(() => {});
    }

    logger.info('Order status updated', { orderId: id, status: value.status, by: req.session.userId });
    res.json({ ok: true, status: value.status });
  } catch (err) {
    next(err);
  }
});

// ── PUT /api/orders/:id/rider-location ─────────────────────────────────────
// Called by the rider app (or demo simulator) to update their GPS position.
// Stores in Redis with a 10-minute TTL and broadcasts SSE to the customer.
const riderLocationSchema = Joi.object({
  lat: Joi.number().min(-90).max(90).required(),
  lng: Joi.number().min(-180).max(180).required(),
});

router.put('/:id/rider-location', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { error, value } = riderLocationSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    // Only the assigned rider or an admin may update
    const { rows } = await db.query(
      'SELECT customer_id, rider_id, status FROM orders WHERE id = $1',
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Order not found' });
    const order = rows[0];
    const isRider = String(order.rider_id) === String(req.session.userId);
    const isAdmin = req.session.role === 'admin';
    if (!isRider && !isAdmin) return res.status(403).json({ error: 'Forbidden' });

    if (!['assigned', 'picked-up'].includes(order.status)) {
      return res.status(409).json({ error: 'Order is not in transit' });
    }

    const key = `rider_loc:${id}`;
    await redisClient.set(key, JSON.stringify({ lat: value.lat, lng: value.lng }), 'EX', 600);

    // Notify the customer via SSE
    broadcast(String(order.customer_id), 'rider_location', {
      orderId: id,
      lat: value.lat,
      lng: value.lng,
    });

    // Push notification when rider is ~10 min away (etaMinutes supplied by rider client)
    const etaMinutes = req.body.etaMinutes ? Number(req.body.etaMinutes) : null;
    const prevKey = `rider_10min_notified:${id}`;
    if (etaMinutes !== null && etaMinutes <= 10) {
      const alreadySent = await redisClient.get(prevKey);
      if (!alreadySent) {
        sendPush(String(order.customer_id),
          '🛵 Rider ~10 minutes away!',
          'Get ready — your fresh produce is almost there.',
          { orderId: id, url: `/?order=${id}` }
        ).catch(() => {});
        await redisClient.set(prevKey, '1', 'EX', 3600);
      }
    }

    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/orders/:id/rider-location ─────────────────────────────────────
// Returns the last known rider position for an in-transit order.
router.get('/:id/rider-location', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    // Only customer, assigned rider, or admin may read
    const { rows } = await db.query(
      'SELECT customer_id, rider_id FROM orders WHERE id = $1',
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Order not found' });
    const order = rows[0];
    const userId = String(req.session.userId);
    const allowed =
      userId === String(order.customer_id) ||
      userId === String(order.rider_id) ||
      req.session.role === 'admin';
    if (!allowed) return res.status(403).json({ error: 'Forbidden' });

    const raw = await redisClient.get(`rider_loc:${id}`);
    if (!raw) return res.status(404).json({ error: 'No location data yet' });

    return res.json(JSON.parse(raw));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
