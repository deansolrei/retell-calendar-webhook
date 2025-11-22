'use strict';

const express = require('express');
const fs = require('fs');    // single fs declaration
const path = require('path');

const PORT = Number(process.env.PORT) || 8080;

const app = express();

// parse JSON bodies for all incoming requests
app.use(express.json({ limit: '512kb' }));

// Try to mount google_calendar_webhook.js (preferred) which itself mounts ./routes/*.
// If not present, fall back to ./routes_index or ./routes folder index.
let mounted = false;
try {
  const gcw = require('./google_calendar_webhook');
  if (gcw && typeof gcw === 'function' || (gcw && gcw.stack && typeof gcw.use === 'function')) {
    // if it exports a router or an app, mount it at root
    app.use('/', gcw);
    console.log('Mounted google_calendar_webhook router (./google_calendar_webhook.js)');
    mounted = true;
  }
} catch (err) {
  // ignore, try next option
}

if (!mounted) {
  try {
    // try routes_index.js or a /routes folder index
    const routes = require('./routes_index') || require('./routes');
    app.use('/', routes);
    console.log('Mounted routes from ./routes_index or ./routes');
    mounted = true;
  } catch (err) {
    console.warn('No route modules found to mount; running with minimal handlers');
  }
}

// Ensure there is always a health endpoint
app.get('/health', (_req, res) => res.json({ ok: true, timestamp: new Date().toISOString() }));

// Error handler (last)
app.use((err, req, res, next) => {
  console.error('UNHANDLED ERROR', err && (err.stack || err.message || err));
  try {
    res.status(500).json({ error: 'server_error', message: 'Internal error' });
  } catch (e) {
    console.error('Failed to send error response:', e && e.message ? e.message : e);
  }
  if (typeof next === 'function') next();
});

// Start server (Cloud Run requires listening on process.env.PORT)
app.listen(PORT, () => {
  console.log(`Calendar API Server running on port ${PORT}`);
  if (!process.env.SECRET_TOKEN) {
    console.warn('Auth: DISABLED (no SECRET_TOKEN env set)');
  } else {
    console.log('Auth: ENABLED');
  }
});

module.exports = app;
