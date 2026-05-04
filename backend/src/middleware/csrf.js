'use strict';

const crypto = require('crypto');

/**
 * Session-based synchronizer token CSRF protection.
 * Replaces the deprecated `csurf` package.
 *
 * Flow:
 *   1. Any GET request (or on login) establishes req.session.csrfToken.
 *   2. Client fetches the token via GET /api/csrf-token.
 *   3. All mutating requests (POST/PUT/PATCH/DELETE) must include
 *      X-CSRF-Token: <token> in the request headers.
 *   4. The middleware compares the header value against the session token.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function csrfProtection(req, res, next) {
  // Ensure every session has a CSRF token; create one on first visit
  if (!req.session.csrfToken) {
    req.session.csrfToken = generateToken();
  }

  if (SAFE_METHODS.has(req.method)) return next();

  const submitted = req.headers['x-csrf-token'];
  if (!submitted || submitted !== req.session.csrfToken) {
    return res.status(403).json({ error: 'Invalid or missing CSRF token' });
  }

  next();
}

function csrfTokenHandler(req, res) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = generateToken();
  }
  res.json({ csrfToken: req.session.csrfToken });
}

// Kept for backward compatibility — no longer needed since we removed csurf,
// but index.js still registers it as an error handler.
function csrfErrorHandler(err, req, res, next) {
  next(err);
}

module.exports = { csrfProtection, csrfTokenHandler, csrfErrorHandler };
