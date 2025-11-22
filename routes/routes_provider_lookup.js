const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/requireAuth');
const providers = require('../providers'); // if you have a providers module
const calendarOps = require('../calendar-operations');

router.post('/provider_lookup', requireAuth, async (req, res) => {
  try {
    const payload = (req.body && req.body.args) ? req.body.args : req.body || {};
    const { state, insurance, q } = payload;

    if (providers && typeof providers.findProviders === 'function') {
      const results = await providers.findProviders({ state, insurance, q });
      return res.json({ ok: true, results });
    }

    // fallback to calendarOps.provider_lookup if present
    if (calendarOps && typeof calendarOps.provider_lookup === 'function') {
      const results = await calendarOps.provider_lookup(payload);
      return res.json({ ok: true, results });
    }

    return res.status(501).json({ error: 'not_implemented', message: 'provider lookup not implemented' });
  } catch (err) {
    console.error('provider_lookup error:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server_error', message: 'Failed in provider_lookup' });
  }
});

module.exports = router;