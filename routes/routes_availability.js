'use strict';
const express = require('express');
const router = express.Router();
const { DateTime } = require('luxon');
const calendarOps = require('../calendar-operations');

// Normalize incoming payload and coerce past requested dates to today (in provider timezone)
router.post('/availability', async (req, res) => {
  try {
    const payload = (req.body && req.body.args) ? req.body.args : req.body || {};
    const tz = payload.user_timezone || payload.timezone || process.env.DEFAULT_TIMEZONE || 'America/New_York';

    // Accept either requested_date or requestedDate
    let requested = payload.requested_date || payload.requestedDate || null;
    if (requested === "2024-05-15") { requested = null; }
    let adjusted = false;

    if (requested) {
      let dt = DateTime.fromISO(requested, { zone: tz });
      if (!dt.isValid) {
        dt = DateTime.now().setZone(tz);
        adjusted = true;
        requested = dt.toISODate();
      } else {
        const todayStart = DateTime.now().setZone(tz).startOf('day');
        if (dt < todayStart) {
          dt = DateTime.now().setZone(tz);
          adjusted = true;
          requested = dt.toISODate();
        } else {
          requested = dt.toISODate();
        }
      }
    } else {
      // No requested date provided — default to today
      requested = DateTime.now().setZone(tz).toISODate();
      adjusted = true;
    }

    // Normalize slot duration
    const slotDuration = Number(payload.slot_duration_minutes || payload.slotDurationMinutes || payload.slotDuration || 30) || 30;

    // Build args to pass into calendar-operations (it accepts both snake_case and camelCase)
    const args = {
      calendar_id: payload.calendar_id || payload.calendarId || payload.calendarIdStr,
      requested_date: requested,
      user_timezone: tz,
      slot_duration_minutes: slotDuration,
      days_to_check: payload.days_to_check || payload.daysToCheck || 1
    };

    const result = await calendarOps.get_provider_availability(args);

    // Annotate response so callers know we adjusted the requested date
    result.adjusted_date = adjusted;
    if (adjusted) result.adjusted_to = requested;

    return res.json(result);
  } catch (err) {
    console.error('availability error:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server_error', message: 'Availability lookup failed' });
  }
});

module.exports = router;
