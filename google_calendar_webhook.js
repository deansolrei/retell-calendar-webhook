'use strict';
/**
 * Router-based GoogleCalendarWebhook.js
 * Exports an express.Router that mounts the functional route modules.
 *
 * This file delegates the logic to route modules under ./routes/
 */
const express = require('express');
const router = express.Router();

// JSON body parsing for this router
router.use(express.json({ limit: '256kb' }));

// Mount sub-routers (expects these files to be in ./routes/)
function mountIfExists(pathRel, mountPath) {
  try {
    const r = require(pathRel);
    router.use(mountPath, r);
    console.log(`Mounted ${pathRel} at ${mountPath}`);
  } catch (err) {
    console.warn(`Optional router ${pathRel} not mounted:`, err && err.message ? err.message : err);
  }
}

// Mount common routes. These modules should export an express.Router.
mountIfExists('./routes/routes_provider_lookup', '/');
mountIfExists('./routes/routes_availability', '/');
mountIfExists('./routes/routes_book', '/');
mountIfExists('./routes/routes_slots', '/');
mountIfExists('./routes/routes_parse', '/');
mountIfExists('./routes/routes_book_provider_appointment', '/');

// Additional short-hand endpoints (helpful if some callers use the root paths directly)
router.post('/provider_lookup', (req, res, next) => { return require('./routes/routes_provider_lookup').handle ? require('./routes/routes_provider_lookup').handle(req, res, next) : next(); });
router.post('/availability', (req, res, next) => { return require('./routes/routes_availability').handle ? require('./routes/routes_availability').handle(req, res, next) : next(); });
router.post('/book', (req, res, next) => { return require('./routes/routes_book').handle ? require('./routes/routes_book').handle(req, res, next) : next(); });
router.post('/slots', (req, res, next) => { return require('./routes/routes_slots').handle ? require('./routes/routes_slots').handle(req, res, next) : next(); });
router.post('/parse-name', (req, res, next) => { return require('./routes/routes_parse').handle ? require('./routes/routes_parse').handle(req, res, next) : next(); });
router.post('/parse-provider', (req, res, next) => { return require('./routes/routes_parse').handle ? require('./routes/routes_parse').handle(req, res, next) : next(); });

// Health endpoint
router.get('/health', (_req, res) => res.json({ ok: true, timestamp: new Date().toISOString() }));

module.exports = router;

// If run directly, start a small server for local testing
if (require.main === module) {
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use('/', router);
  const PORT = Number(process.env.PORT || 8080);
  app.listen(PORT, () => {
    console.log(`GoogleCalendarWebhook (router) listening on port ${PORT}`);
  });
}
