'use strict';

const express    = require('express');
const { rateLimit } = require('express-rate-limit');
const logger     = require('../logger');

const router = express.Router();

const errorReportLimiter = rateLimit({
  windowMs: 60 * 1000,   // 1 minute
  max: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many error reports. Please slow down.' },
});

// POST /api/errors — receives client-side error reports (session required + rate limited)
router.post('/', errorReportLimiter, (req, res) => {
  // Accept reports only from authenticated sessions; drop anonymous noise
  if (!req.session?.userId) return res.status(401).json({ error: 'Authentication required' });
  const { errorId, message, stack, url, componentStack } = req.body || {};
  logger.error('Client-side error reported', {
    errorId, message,
    stack:          stack?.slice(0, 500),
    componentStack: componentStack?.slice(0, 500),
    url,
    userId: req.session?.userId || null,
    userAgent: req.headers['user-agent'],
  });
  res.status(204).end();
});

module.exports = router;
