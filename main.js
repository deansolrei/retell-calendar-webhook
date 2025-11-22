
const express = require('express');

const bodyParser = require('body-parser');

const fs = require('fs');

const path = require('path');

const PORT = process.env.PORT || 8080;

const app = express();

// parse JSON bodies for all incoming requests
app.use(bodyParser.json({ limit: '512kb' }));
// Try to mount a routes index if present (recommended: place your route modules in ./routes/)
try {
  const routes = require('./routes'); // expects ./routes/index.js
  app.use('/', routes);
  console.log('Mounted ./routes (router index) for endpoint handlers');
} catch (err) {
  // Fallback: try router-based GoogleCalendarWebhook (exports a router)
  try {
    const gcw = require('./google_calendar_webhook');
    if (gcw && typeof gcw === 'function') {
      app.use('/', gcw);
      console.log('Mounted router from google_calendar_webhook.js');
    } else {
      console.warn('No ./routes and google_calendar_webhook did not export a router — starting with minimal handlers');
      // Minimal health endpoint
      app.get('/', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));
    }
  } catch (err2) {
    console.warn('Failed to mount google_calendar_webhook router:', err2 && err2.message ? err2.message : err2);
    // Minimal health endpoint
    app.get('/', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));
  }
}
// Generic health (always available)
app.get('/health', (_req, res) => res.json({ ok: true, timestamp: new Date().toISOString() }));
// Error handler (last)
app.use((err, req, res, next) => {
  console.error('UNHANDLED ERROR', err && (err.stack || err.message || err));
  try {
    res.status(500).json({ error: 'server_error', message: 'Internal error' });
  } catch (e) {
    // fallback if response already sent
    console.error('Failed to send error response:', e && e.message ? e.message : e);
  }
  next && next();
});

app.listen(PORT, () => {
  console.log(`Calendar API Server running on port ${PORT}`);
  if (!process.env.SECRET_TOKEN) {
    console.warn('Auth: DISABLED (no SECRET_TOKEN env set)');
  } else {
    console.log('Auth: ENABLED');
  }
});

module.exports = app;
