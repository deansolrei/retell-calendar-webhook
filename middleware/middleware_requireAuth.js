/**
 * Simple auth middleware for bearer SECRET_TOKEN.
 * - If SECRET_TOKEN is unset, middleware will allow all requests (use cautiously).
 * - If ALLOW_UNAUTH_PARSE=true, parse routes can bypass auth (but middleware still functions).
 *
 * Use by: const requireAuth = require('../middleware/requireAuth');
 * then in route: router.post('/foo', requireAuth, handler)
 */

module.exports = function requireAuth(req, res, next) {
  // Allow unauthenticated parse endpoints via env if desired
  if (process.env.ALLOW_UNAUTH_PARSE === 'true') {
    return next();
  }

  const SECRET_TOKEN = process.env.SECRET_TOKEN || '';
  if (!SECRET_TOKEN) {
    // no secret configured => accept (but we warn server-side)
    console.warn('requireAuth: SECRET_TOKEN not configured, allowing requests (development mode)');
    return next();
  }

  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const valid = authHeader === `Bearer ${SECRET_TOKEN}`;
  if (!valid) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  return next();
};