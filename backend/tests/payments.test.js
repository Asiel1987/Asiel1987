'use strict';

const crypto  = require('crypto');
const request = require('supertest');
const { makeApp } = require('./helpers');

// ── Module mocks ──────────────────────────────────────────────────────────────
jest.mock('../src/db');
jest.mock('../src/redis', () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn(),
}));
jest.mock('../src/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../src/services/stripe',     () => ({ createPaymentIntent: jest.fn(), confirmPayment: jest.fn(), constructWebhookEvent: jest.fn() }));
jest.mock('../src/services/selcom',     () => ({ initiatePush: jest.fn() }));
jest.mock('../src/services/mpesaKenya', () => ({ initiateSTKPush: jest.fn() }));

const db             = require('../src/db');
const paymentsRouter = require('../src/routes/payments');

// ── Fixtures ──────────────────────────────────────────────────────────────────
const OWNER_ID   = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER_ID   = 'cccccccc-0000-4000-8000-000000000003';
const PAYMENT_REF = 'test-ref-001';

const MOCK_PAYMENT = {
  ref:          PAYMENT_REF,
  status:       'pending',
  method:       'card',
  provider_ref: 'pi_test123',
  order_id:     'dddddddd-0000-4000-8000-000000000004',
};

// ── GET /:ref/status — ownership (C-2) ────────────────────────────────────────

describe('GET /:ref/status — payment ownership check', () => {
  test('owner can read their own payment status', async () => {
    db.query.mockResolvedValueOnce({ rows: [MOCK_PAYMENT] });

    const app = makeApp(paymentsRouter, { userId: OWNER_ID, role: 'customer' });
    const res = await request(app).get(`/${PAYMENT_REF}/status`);

    expect(res.status).toBe(200);
    expect(res.body.ref).toBe(PAYMENT_REF);
    expect(res.body.status).toBe('pending');
  });

  test('non-owner receives 404 — cannot see another user\'s payment', async () => {
    // DB returns empty rows because JOIN filters out the mismatch
    db.query.mockResolvedValueOnce({ rows: [] });

    const app = makeApp(paymentsRouter, { userId: OTHER_ID, role: 'customer' });
    const res = await request(app).get(`/${PAYMENT_REF}/status`);

    expect(res.status).toBe(404);
  });

  test('admin can read any payment', async () => {
    db.query.mockResolvedValueOnce({ rows: [MOCK_PAYMENT] });

    const app = makeApp(paymentsRouter, { userId: OTHER_ID, role: 'admin' });
    const res = await request(app).get(`/${PAYMENT_REF}/status`);

    expect(res.status).toBe(200);
  });

  test('unauthenticated request returns 401', async () => {
    const app = makeApp(paymentsRouter, {}); // no userId in session
    const res = await request(app).get(`/${PAYMENT_REF}/status`);
    expect(res.status).toBe(401);
  });
});

// ── POST /selcom/callback — HMAC verification (H-6) ──────────────────────────

describe('POST /selcom/callback — HMAC verification', () => {
  const CALLBACK_BODY = { transid: 'txn-001', utilityref: 'ref-001', result: 'SUCCESS' };
  const SECRET = 'test-selcom-secret';

  function makeSignature(body, secret) {
    return crypto
      .createHmac('sha256', secret)
      .update(JSON.stringify(body))
      .digest('hex');
  }

  beforeEach(() => {
    // Reset env and db mock before each test
    delete process.env.SELCOM_API_SECRET;
    db.query.mockResolvedValue({ rows: [], rowCount: 1 });
  });

  test('processes callback when SELCOM_API_SECRET is not configured (dev/sandbox)', async () => {
    const app = makeApp(paymentsRouter, {});
    const res = await request(app)
      .post('/selcom/callback')
      .send(CALLBACK_BODY);

    expect(res.status).toBe(200);
    expect(res.body.result).toBe('SUCCESS');
  });

  test('accepts callback with valid HMAC signature', async () => {
    process.env.SELCOM_API_SECRET = SECRET;

    const app = makeApp(paymentsRouter, {});
    const sig = makeSignature(CALLBACK_BODY, SECRET);

    const res = await request(app)
      .post('/selcom/callback')
      .set('x-selcom-signature', sig)
      .send(CALLBACK_BODY);

    expect(res.status).toBe(200);
    expect(res.body.result).toBe('SUCCESS');
  });

  test('rejects callback with wrong HMAC signature', async () => {
    process.env.SELCOM_API_SECRET = SECRET;

    const app = makeApp(paymentsRouter, {});
    const res = await request(app)
      .post('/selcom/callback')
      .set('x-selcom-signature', 'wrong-signature-value-padded-to-length-00000000000000')
      .send(CALLBACK_BODY);

    expect(res.status).toBe(400);
  });

  test('rejects callback with missing signature header when secret is configured', async () => {
    process.env.SELCOM_API_SECRET = SECRET;

    const app = makeApp(paymentsRouter, {});
    const res = await request(app)
      .post('/selcom/callback')
      .send(CALLBACK_BODY);

    expect(res.status).toBe(400);
  });

  test('marks payment as completed on SUCCESS result', async () => {
    const app = makeApp(paymentsRouter, {});
    await request(app).post('/selcom/callback').send(CALLBACK_BODY);

    const updateCall = db.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes("status='completed'")
    );
    expect(updateCall).toBeDefined();
    expect(updateCall[1][0]).toBe(CALLBACK_BODY.transid);
  });

  test('marks payment as failed on non-SUCCESS result', async () => {
    const app = makeApp(paymentsRouter, {});
    await request(app)
      .post('/selcom/callback')
      .send({ ...CALLBACK_BODY, result: 'FAILED' });

    const updateCall = db.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes("status='failed'")
    );
    expect(updateCall).toBeDefined();
  });
});
