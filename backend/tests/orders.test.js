'use strict';

const request = require('supertest');
const { makeApp, makeMockClient } = require('./helpers');

// ── Module mocks (must be before any require of the module under test) ────────
jest.mock('../src/db');
jest.mock('../src/redis', () => ({
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  publish: jest.fn().mockResolvedValue(0),
}));
jest.mock('../src/routes/events', () => ({
  broadcast: jest.fn(),
  router: require('express').Router(),
}));
jest.mock('../src/services/push', () => ({ sendPush: jest.fn() }));
jest.mock('../src/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const db    = require('../src/db');
const ordersRouter = require('../src/routes/orders');

// ── Fixtures ──────────────────────────────────────────────────────────────────
const CUSTOMER_ID  = 'aaaaaaaa-0000-4000-8000-000000000001';
const PRODUCT_ID   = 'bbbbbbbb-0000-4000-8000-000000000002';
const ORDER_ID_RE  = /^[0-9a-f-]{36}$/;

const MOCK_PRODUCT = {
  id:        PRODUCT_ID,
  tzs_price: 10000,
  stock_qty: 50,
  available: true,
  country:   'TZ',
};

function session(overrides = {}) {
  return { userId: CUSTOMER_ID, role: 'customer', country: 'TZ', ...overrides };
}

function orderBody(overrides = {}) {
  return {
    country:         'TZ',
    deliveryAddress: '123 Kariakoo St',
    items:           [{ productId: PRODUCT_ID, qty: 2 }],
    deliveryFee:     0,
    discount:        0,
    loyaltyPtsRedeem: 0,
    ...overrides,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build mock client query results for a single-item order with optional loyalty.
 * Sequence mirrors the exact order of client.query() calls in orders.js POST /.
 */
function buildClientResults({ loyaltyPts = 0, loyaltyPtsRedeem = 0 } = {}) {
  const results = [
    { rows: [], rowCount: 0 },                          // BEGIN
    { rows: [MOCK_PRODUCT], rowCount: 1 },              // SELECT products FOR UPDATE
    { rows: [], rowCount: 1 },                          // INSERT order_items
    { rows: [], rowCount: 1 },                          // UPDATE products stock
    { rows: [], rowCount: 1 },                          // INSERT orders
  ];
  if (loyaltyPtsRedeem > 0) {
    results.push(
      { rows: [{ loyalty_pts: loyaltyPts }], rowCount: 1 }, // SELECT loyalty_pts FOR UPDATE
      { rows: [], rowCount: 1 },                             // UPDATE users loyalty_pts
    );
  }
  results.push({ rows: [], rowCount: 0 });              // COMMIT
  return results;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /  (order creation)', () => {
  let app;

  beforeEach(() => {
    app = makeApp(ordersRouter, session());
  });

  test('creates order without loyalty redemption — chargeableTzs equals totalTzs', async () => {
    const mockClient = makeMockClient(buildClientResults());
    db.getClient.mockResolvedValue(mockClient);

    const res = await request(app).post('/').send(orderBody());

    expect(res.status).toBe(201);
    // 2 units × 10 000 TZS = 20 000
    expect(res.body.totalTzs).toBe(20000);
    expect(res.body.chargeableTzs).toBe(20000);
    expect(res.body.status).toBe('pending');
    expect(res.body.id).toMatch(ORDER_ID_RE);
  });

  test('deducts loyalty points and reduces chargeableTzs', async () => {
    const REDEEM = 3000;
    const mockClient = makeMockClient(
      buildClientResults({ loyaltyPts: 5000, loyaltyPtsRedeem: REDEEM })
    );
    db.getClient.mockResolvedValue(mockClient);

    const res = await request(app)
      .post('/')
      .send(orderBody({ loyaltyPtsRedeem: REDEEM }));

    expect(res.status).toBe(201);
    expect(res.body.totalTzs).toBe(20000);
    expect(res.body.chargeableTzs).toBe(20000 - REDEEM);   // 17 000

    // Verify the UPDATE users SET loyalty_pts call used the correct delta
    const loyaltyCalls = mockClient.query.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes('loyalty_pts = loyalty_pts -')
    );
    expect(loyaltyCalls).toHaveLength(1);
    expect(loyaltyCalls[0][1][0]).toBe(REDEEM);
  });

  test('caps loyalty redemption at order total — chargeableTzs never goes negative', async () => {
    const REDEEM = 99999; // more than the 20 000 order value
    const mockClient = makeMockClient(
      buildClientResults({ loyaltyPts: 99999, loyaltyPtsRedeem: REDEEM })
    );
    db.getClient.mockResolvedValue(mockClient);

    const res = await request(app)
      .post('/')
      .send(orderBody({ loyaltyPtsRedeem: REDEEM }));

    expect(res.status).toBe(201);
    expect(res.body.chargeableTzs).toBe(0);
  });

  test('rejects order when user has insufficient loyalty points', async () => {
    const mockClient = makeMockClient(
      buildClientResults({ loyaltyPts: 100, loyaltyPtsRedeem: 3000 })
    );
    db.getClient.mockResolvedValue(mockClient);

    const res = await request(app)
      .post('/')
      .send(orderBody({ loyaltyPtsRedeem: 3000 }));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/insufficient loyalty/i);
    // ROLLBACK must have been called
    const rollbackCalls = mockClient.query.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes('ROLLBACK')
    );
    expect(rollbackCalls.length).toBeGreaterThanOrEqual(1);
  });

  test('rejects out-of-stock product', async () => {
    const oosClient = makeMockClient([
      { rows: [], rowCount: 0 },   // BEGIN
      { rows: [{ ...MOCK_PRODUCT, stock_qty: 0, available: false }], rowCount: 1 },
    ]);
    db.getClient.mockResolvedValue(oosClient);

    const res = await request(app).post('/').send(orderBody());

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not available/i);
  });

  test('returns 400 for invalid request body', async () => {
    const res = await request(app).post('/').send({ country: 'TZ' }); // missing required fields
    expect(res.status).toBe(400);
  });
});
