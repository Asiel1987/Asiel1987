'use strict';

const logger = require('../logger');

/**
 * Global Express error handler.
 * Must be the LAST middleware registered in index.js (4-argument signature).
 *
 * Handles:
 *  - Joi validation errors  (err.isJoi / err.name === 'ValidationError')
 *  - PostgreSQL errors       (err.code is a 5-char SQLSTATE string)
 *  - Generic application errors
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // ── Joi Validation Error ──────────────────────────────────────────────────
  if (err.isJoi || err.name === 'ValidationError') {
    return res.status(400).json({
      error: 'Validation failed',
      details: err.details ? err.details.map((d) => d.message) : [err.message],
    });
  }

  // ── PostgreSQL / pg errors ────────────────────────────────────────────────
  if (err.code && typeof err.code === 'string' && err.code.length === 5) {
    const isProd = process.env.NODE_ENV === 'production';

    // Log full details server-side; never expose table/constraint names to client
    logger.error('Database error', {
      pgCode:     err.code,
      detail:     isProd ? '[redacted]' : err.detail,
      table:      isProd ? '[redacted]' : err.table,
      constraint: isProd ? '[redacted]' : err.constraint,
      path:       req.path,
      method:     req.method,
    });

    // Unique constraint violation
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Duplicate entry' });
    }
    // Foreign key violation
    if (err.code === '23503') {
      return res.status(409).json({ error: 'Related resource not found' });
    }
    // Not-null violation
    if (err.code === '23502') {
      return res.status(400).json({ error: 'Missing required field' });
    }

    return res.status(500).json({ error: 'Database error' });
  }

  // ── HTTP errors with explicit status codes ────────────────────────────────
  const status = err.status || err.statusCode || 500;

  logger.error('Unhandled error', {
    message: err.message,
    stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined,
    path: req.path,
    method: req.method,
    status,
  });

  // Never leak stack traces in production
  res.status(status).json({
    error: err.expose || status < 500 ? err.message : 'Internal server error',
  });
}

module.exports = errorHandler;
