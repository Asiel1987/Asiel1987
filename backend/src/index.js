'use strict';

// Load environment variables first — before any other require
require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const session = require('express-session');
const RedisStore = require('connect-redis').default;

const redisClient = require('./redis');
const logger = require('./logger');
const errorHandler = require('./middleware/errorHandler');
const { generalLimiter } = require('./middleware/rateLimit');
const { csrfProtection, csrfTokenHandler, csrfErrorHandler } = require('./middleware/csrf');

// ── Route modules ─────────────────────────────────────────────────────────────
const authRouter = require('./routes/auth');
const usersRouter = require('./routes/users');
const productsRouter = require('./routes/products');
const ordersRouter = require('./routes/orders');
const paymentsRouter = require('./routes/payments');
const eventsModule = require('./routes/events');   // { router, broadcast }
const fxRouter = require('./routes/fx');
const errorsRouter = require('./routes/errors');
const vfdRouter = require('./routes/vfd');

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

// ── Trust proxy (required for secure cookies behind Fly.io / Nginx / ALB) ────
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

// ── Security headers (Helmet + CSP) ──────────────────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        frameSrc: ["'none'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests:
          process.env.NODE_ENV === 'production' ? [] : null,
      },
    },
    hsts: {
      maxAge: 31_536_000,      // 1 year in seconds
      includeSubDomains: true,
      preload: true,
    },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    crossOriginEmbedderPolicy: false,
  })
);

// ── CORS ──────────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:5173')
  .split(',')
  .map((o) => o.trim());

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error(`CORS: origin '${origin}' not allowed`));
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-CSRF-Token'],
    exposedHeaders: ['X-Request-Id'],
  })
);

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ── Session (Redis-backed, httpOnly, secure in production) ───────────────────
const sessionSecret = process.env.SESSION_SECRET || (() => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET env var is required in production');
  }
  logger.warn('Using insecure dev SESSION_SECRET — set SESSION_SECRET in .env');
  return 'dev-only-insecure-secret-change-me';
})();

app.use(
  session({
    store: new RedisStore({ client: redisClient, prefix: 'sess:' }),
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    name: 'asf_sid',
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,   // 7 days in ms
    },
  })
);

// ── Global rate limiter (100 req / 15 min per IP) ─────────────────────────────
app.use(generalLimiter);

// ── Health check — no auth, no CSRF, no rate limit ───────────────────────────
app.get('/health', (_req, res) =>
  res.json({ status: 'ok', ts: new Date().toISOString() })
);

// ── CSRF protection ───────────────────────────────────────────────────────────
// csrfProtection attaches req.csrfToken() to all requests.
// Mutations (POST/PUT/DELETE/PATCH) must include the X-CSRF-Token header.
// GET /api/csrf-token is the bootstrap endpoint — it must come AFTER csrfProtection
// is applied so that req.csrfToken() is available, but is itself a GET (not validated).
app.use(csrfProtection);
app.get('/api/csrf-token', csrfTokenHandler);

// ── API routers ───────────────────────────────────────────────────────────────
app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/products', productsRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/events', eventsModule.router);
app.use('/api/fx', fxRouter);
app.use('/api/errors', errorsRouter);
app.use('/api/vfd', vfdRouter);

// ── CSRF error handler (before global error handler) ─────────────────────────
app.use(csrfErrorHandler);

// ── 404 catch-all ─────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));

// ── Global error handler (must be registered last) ───────────────────────────
app.use(errorHandler);

// ── Start server ──────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  logger.info('Asiel Farm Shop API started', {
    port: PORT,
    env: process.env.NODE_ENV || 'development',
    pid: process.pid,
  });
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function shutdown(signal) {
  logger.info(`${signal} received — starting graceful shutdown`);
  server.close(() => {
    logger.info('HTTP server closed');
    redisClient.quit().then(() => {
      logger.info('Redis connection closed');
      process.exit(0);
    });
  });

  // Force-kill after 15 s if graceful shutdown hangs
  setTimeout(() => {
    logger.error('Forced exit after shutdown timeout');
    process.exit(1);
  }, 15_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

module.exports = app;   // exported for supertest integration tests
