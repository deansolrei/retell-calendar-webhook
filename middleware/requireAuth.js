module.exports = function requireAuth(req, res, next) {
  // If SECRET_TOKEN not set, treat as disabled (useful for local dev)
  const expected = process.env.SECRET_TOKEN;
  if (!expected) return next();

  const auth = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (!auth.startsWith('Bearer ')) {
    res.status(401).json({ error: 'unauthorized', message: 'Authorization header required' });
    return;
  }
  const token = auth.split(/\s+/)[1];
  if (!token || token !== expected) {
    res.status(403).json({ error: 'forbidden', message: 'Invalid token' });
    return;
  }
  return next();
};
