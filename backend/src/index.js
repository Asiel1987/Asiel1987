'use strict';

require('dotenv').config();
const express      = require('express');
const helmet       = require('helmet');
const cors         = require('cors');
const session      = require('express-session');
const RedisStore   = require('connect-redis').default;
const redisClient  = require('./redis');
const logger       = require('./logger');
const errorHandler = require('./middleware/errorHandler');

const authRouter     = require('./routes/auth');
const usersRouter    = require('./routes/users');
const productsRouter = require('./routes/products');
const ordersRouter   = require('./routes/orders');
const paymentsRouter = require('./routes/payments');
const { router: eventsRouter } = require('./routes/events');
const fxRouter       = require('./routes/fx');
const errorsRouter   = require('./routes/errors');
const vfdRouter      = require('./routes/vfd');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Security headers ──────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'"],
      styleSrc:   ["'self'", "https://fonts.googleapis.com"],
      fontSrc:    ["'self'", "https://fonts.gstatic.com"],
      imgSrc:     ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true },
}));

// ── CORS ──────────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:5173').split(',');
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));

// ── Session ───────────────────────────────────────────────────────────────────
app.use(session({
  store: new RedisStore({ client: redisClient }),
  secret: process.env.SESSION_SECRET || 'change-me-in-production',
  resave: false,
  saveUninitialized: false,
  name: 'asf_sid',
  cookie: {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge:   7 * 24 * 60 * 60 * 1000, // 7 days
  },
}));

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/auth',     authRouter);
app.use('/api/users',    usersRouter);
app.use('/api',          productsRouter);
app.use('/api/orders',   ordersRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/events',   eventsRouter);
app.use('/api/fx',       fxRouter);
app.use('/api/errors',   errorsRouter);
app.use('/api/vfd',      vfdRouter);

// ── CSRF token endpoint ───────────────────────────────────────────────────────
app.get('/api/csrf-token', (req, res) => {
  const token = require('crypto').randomBytes(32).toString('hex');
  req.session.csrfToken = token;
  res.json({ token });
});

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ── Global error handler ──────────────────────────────────────────────────────
app.use(errorHandler);

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info(`Asiel Farm Shop API listening on port ${PORT}`, {
    env:  process.env.NODE_ENV || 'development',
    port: PORT,
  });
});

module.exports = app; // for supertest
