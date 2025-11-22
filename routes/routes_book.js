const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/requireAuth');
const calendarOps = require('../calendar-operations');

router.post('/book', requireAuth, async (req, res) => {
  try {
    const payload = (req.body && req.body.args) ? req.body.args : req.body || {};
    const { calendar_id, calendar_event } = payload;
    if (!calendar_id || !calendar_event) {
      return res.status(400).json({ error: 'bad_request', message: 'calendar_id and calendar_event required' });
    }

    if (calendarOps && typeof calendarOps.book_provider_appointment === 'function') {
      const result = await calendarOps.book_provider_appointment({
        calendarId: calendar_id,
        event: calendar_event,
        payload
      });
      return res.json(result);
    }

    // If calendarOps missing, return helpful message
    return res.status(501).json({ error: 'not_implemented', message: 'Booking handler not implemented' });
  } catch (err) {
    console.error('book error:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server_error', message: 'Failed to book appointment' });
  }
});

module.exports = router;