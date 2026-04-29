'use strict';

const csurf = require('csurf');

/**
 * csrfProtection middleware
 *
 * Uses csurf with cookie-based token storage.
 * The token must be sent by the client as the X-CSRF-Token header
 * (or _csrf body field) on all state-mutating requests (POST, PUT, DELETE, PATCH).
 *
 * GET /api/csrf-token is intentionally excluded from CSRF validation
 * so the client can bootstrap the token.
 */
const csrfProtection = csurf({
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
  },
});

/**
 * GET /api/csrf-token
 * Returns a fresh CSRF token for the current session.
 * The client should store this and include it as the X-CSRF-Token header.
 */
function csrfTokenHandler(req, res) {
  res.json({ csrfToken: req.csrfToken() });
}

/**
 * CSRF error handler — must be mounted before the global error handler.
 * csurf throws an error with code 'EBADCSRFTOKEN' when the token is invalid.
 */
function csrfErrorHandler(err, req, res, next) {
  if (err.code === 'EBADCSRFTOKEN') {
    return res.status(403).json({ error: 'Invalid or missing CSRF token' });
  }
  next(err);
}

module.exports = { csrfProtection, csrfTokenHandler, csrfErrorHandler };
