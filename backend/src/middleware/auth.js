'use strict';

/**
 * requireAuth
 * Middleware that checks req.session.userId is present.
 * If not, responds 401 Unauthorized.
 */
function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

/**
 * requireRole(role)
 * Returns middleware that checks req.session.role equals the given role.
 * If not, responds 403 Forbidden.
 * Must be used after requireAuth.
 *
 * @param {string|string[]} role - A single role string or array of allowed roles
 */
function requireRole(role) {
  const allowed = Array.isArray(role) ? role : [role];
  return (req, res, next) => {
    if (!req.session || !req.session.role) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!allowed.includes(req.session.role)) {
      return res.status(403).json({
        error: 'Forbidden',
        detail: `Required role: ${allowed.join(' or ')}`,
      });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
