const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/requireAuth');
const calendarOps = require('../calendar-operations');

router.post('/slots', requireAuth, async (req, res) => {
  try {
    const payload = (req.body && req.body.args) ? req.body.args : req.body || {};
    const { calendar_id, requested_date, slot_duration_minutes } = payload;
    if (!calendar_id) return res.status(400).json({ error: 'bad_request', message: 'calendar_id required' });

    if (calendarOps && typeof calendarOps.get_calendar_slots === 'function') {
      const result = await calendarOps.get_calendar_slots({
        calendarId: calendar_id,
        requestedDate: requested_date,
        slotDurationMinutes: Number(slot_duration_minutes || 30),
      });
      return res.json(result);
    }

    return res.status(501).json({ error: 'not_implemented', message: 'Slots handler not implemented' });
  } catch (err) {
    console.error('slots error:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server_error', message: 'Failed to fetch slots' });
  }
});

module.exports = router;