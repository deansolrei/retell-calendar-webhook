const express = require('express');
const bodyParser = require('body-parser');
const requireAuth = require('./middleware/requireAuth');
const routes = require('./routes');

const PORT = process.env.PORT || 8080;
const app = express();

app.use(bodyParser.json());

// Health
app.get('/', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// Mount routes (routes files apply requireAuth as needed)
app.use('/', routes);

// Error handler (last)
app.use((err, req, res, next) => {
  console.error('UNHANDLED ERROR', err && (err.stack || err.message || err));
  res.status(500).json({ error: 'server_error', message: 'Internal error' });
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
