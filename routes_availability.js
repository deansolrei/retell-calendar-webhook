const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/requireAuth');
const calendarOps = require('../calendar-operations'); // adapt path if different

router.post('/availability', requireAuth, async (req, res) => {
  try {
    // Accept two shapes: { args: { ... } } (Retell style) or direct body
    const payload = (req.body && req.body.args) ? req.body.args : req.body || {};
    const { calendar_id, requested_date, slot_duration_minutes } = payload;

    if (!calendar_id) {
      return res.status(400).json({ error: 'bad_request', message: 'calendar_id required' });
    }

    // Prefer get_provider_availability if available
    if (calendarOps && typeof calendarOps.get_provider_availability === 'function') {
      const result = await calendarOps.get_provider_availability({
        calendarId: calendar_id,
        requestedDate: requested_date,
        slotDurationMinutes: Number(slot_duration_minutes || 30),
      });
      return res.json(result);
    }

    // Fallback to get_calendar_slots if that's implemented
    if (calendarOps && typeof calendarOps.get_calendar_slots === 'function') {
      const result = await calendarOps.get_calendar_slots({
        calendarId: calendar_id,
        requestedDate: requested_date,
        slotDurationMinutes: Number(slot_duration_minutes || 30),
      });
      return res.json(result);
    }

    return res.status(501).json({ error: 'not_implemented', message: 'Availability handler not implemented' });
  } catch (err) {
    console.error('availability error:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server_error', message: 'Failed to fetch availability' });
  }
});

module.exports = router;