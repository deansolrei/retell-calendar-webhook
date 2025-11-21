const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/requireAuth');
const calendarOps = require('../calendar-operations');

router.post('/parse-name', requireAuth, async (req, res) => {
  try {
    const payload = (req.body && req.body.args) ? req.body.args : req.body || {};
    if (calendarOps && typeof calendarOps.parse_patient_name === 'function') {
      const out = await calendarOps.parse_patient_name(payload);
      return res.json(out);
    }
    return res.status(501).json({ error: 'not_implemented', message: 'parse_patient_name not available' });
  } catch (err) {
    console.error('parse-name error:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server_error', message: 'Failed to parse name' });
  }
});

router.post('/parse-provider', requireAuth, async (req, res) => {
  try {
    const payload = (req.body && req.body.args) ? req.body.args : req.body || {};
    if (calendarOps && typeof calendarOps.parse_provider_name === 'function') {
      const out = await calendarOps.parse_provider_name(payload);
      return res.json(out);
    }
    return res.status(501).json({ error: 'not_implemented', message: 'parse_provider_name not available' });
  } catch (err) {
    console.error('parse-provider error:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server_error', message: 'Failed to parse provider name' });
  }
});

module.exports = router;