'use strict';

const express = require('express');
const logger  = require('../logger');

const router = express.Router();

// POST /api/errors — receives client-side error reports
router.post('/', (req, res) => {
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
