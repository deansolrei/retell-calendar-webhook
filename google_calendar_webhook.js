'use strict';
/**
 * Router-based GoogleCalendarWebhook.js
 *
 * Exports an express.Router with endpoints:
 *  - POST /provider_lookup
 *  - POST /availability
 *  - POST /book
 *  - GET  /health
 *
 * If run directly (node GoogleCalendarWebhook.js) it will mount the router on a small app and listen.
 *
 * This file expects:
 *  - ./providers module (exports getProvider/findProviders/getProviders)
 *  - ./calendar-operations module with functions used below
 *  - GOOGLE_CREDS / GCAL_KEY_JSON, GOOGLE_IMPERSONATE_USER env vars for calendar operations
 */
const express = require('express');
const { google } = require('googleapis');
const { DateTime } = require('luxon');
const fs = require('fs');
const path = require('path');

const providers = require('./providers'); // optional helper; used by provider_lookup
const calendarOps = require('./calendar-operations'); // expected helper for availability/book operations

const router = express.Router();

// capture raw body while still parsing JSON (helpful for signature verify if needed)
router.use(express.json({
  limit: '256kb',
  verify: (req, _res, buf) => {
    try { req.rawBody = buf && buf.length ? buf.toString('utf8') : ''; } catch (e) { req.rawBody = ''; }
  }
}));

// Config envs and defaults
const SECRET_TOKEN = process.env.SECRET_TOKEN || '';
const GOOGLE_CREDS_ENV = process.env.GOOGLE_CREDS || process.env.GCAL_KEY_JSON || null;
const GOOGLE_IMPERSONATE_USER = process.env.GOOGLE_IMPERSONATE_USER || process.env.GCAL_SUBJECT || null;
const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || (calendarOps && calendarOps.DEFAULT_TIMEZONE) || 'America/New_York';
const DEFAULT_DAYS_TO_CHECK = Number(process.env.DAYS_TO_CHECK_AHEAD || 7);
const DEFAULT_REQUIRED_FREE_MINUTES = Number(process.env.DEFAULT_REQUIRED_FREE_MINUTES || (calendarOps && calendarOps.DEFAULT_REQUIRED_FREE_MINUTES) || 30);

// Helper: validate incoming bearer token
function checkAuthBearer(req) {
  const auth = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (!SECRET_TOKEN) return true; // if no secret configured, accept (use cautiously)
  return auth === `Bearer ${SECRET_TOKEN}`;
}

function requireAuth(req, res) {
  if (!checkAuthBearer(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// ---------- Routes ----------

// Provider lookup: find providers by state/insurance or other filter
// Expected body: { state: 'FL', insurance: 'Cigna' }
router.post('/provider_lookup', async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const { state, insurance, q } = req.body || {};
    if (providers && typeof providers.findProviders === 'function') {
      const results = await providers.findProviders({ state, insurance, q });
      return res.json({ ok: true, results });
    }
    // fallback if providers module not implemented
    return res.status(501).json({ error: 'not_implemented', message: 'providers.findProviders not available' });
  } catch (err) {
    console.error('provider_lookup error:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server_error', message: err && err.message ? err.message : 'Failed in provider_lookup' });
  }
});

// Get provider availability / calendar slots
// Expected body: { calendar_id, requested_date, slot_duration_minutes }
router.post('/availability', async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const { calendar_id, requested_date, slot_duration_minutes } = req.body || {};
    if (!calendar_id) return res.status(400).json({ error: 'bad_request', message: 'calendar_id required' });

    // Delegate to calendar-operations if present
    if (calendarOps && typeof calendarOps.get_provider_availability === 'function') {
      const daysToCheck = DEFAULT_DAYS_TO_CHECK;
      const requiredMinutes = slot_duration_minutes || DEFAULT_REQUIRED_FREE_MINUTES;
      const avail = await calendarOps.get_provider_availability({
        calendarId: calendar_id,
        requestedDate: requested_date,
        slotDurationMinutes: Number(requiredMinutes),
        daysToCheck,
        timezone: DEFAULT_TIMEZONE,
        impersonateUser: GOOGLE_IMPERSONATE_USER,
        googleCredsEnv: GOOGLE_CREDS_ENV
      });
      return res.json(avail);
    }

    // Fallback: if calendarOps exposes get_calendar_slots
    if (calendarOps && typeof calendarOps.get_calendar_slots === 'function') {
      const slots = await calendarOps.get_calendar_slots({
        calendarId: calendar_id,
        requestedDate: requested_date,
        slotDurationMinutes: Number(slot_duration_minutes || DEFAULT_REQUIRED_FREE_MINUTES),
        daysToCheck: DEFAULT_DAYS_TO_CHECK,
        timezone: DEFAULT_TIMEZONE
      });
      return res.json({ ok: true, slots });
    }

    return res.status(501).json({ error: 'not_implemented', message: 'calendar operations not available' });
  } catch (err) {
    console.error('availability error:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server_error', message: 'Failed to fetch availability' });
  }
});

// Book provider appointment
// Expected body: { calendar_id, provider_token?, patient_name?, patient_email?, calendar_event: { summary, start:{dateTime,timeZone}, end:{dateTime,timeZone}, attendees: [...] } }
router.post('/book', async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const payload = req.body || {};
    const { calendar_id, calendar_event } = payload;
    if (!calendar_id || !calendar_event) {
      return res.status(400).json({ error: 'bad_request', message: 'calendar_id and calendar_event are required' });
    }

    // Delegate to calendarOps.book_provider_appointment if available
    if (calendarOps && typeof calendarOps.book_provider_appointment === 'function') {
      const result = await calendarOps.book_provider_appointment({
        calendarId: calendar_id,
        event: calendar_event,
        payload,
        impersonateUser: GOOGLE_IMPERSONATE_USER,
        googleCredsEnv: GOOGLE_CREDS_ENV
      });
      return res.json(result);
    }

    // Minimal default implementation using service account creds (if provided)
    if (GOOGLE_CREDS_ENV || fs.existsSync(path.join(process.cwd(), 'gcal-creds.json'))) {
      let creds;
      if (process.env.GOOGLE_CREDS) {
        creds = JSON.parse(process.env.GOOGLE_CREDS);
      } else if (process.env.GCAL_KEY_JSON) {
        creds = JSON.parse(process.env.GCAL_KEY_JSON);
      } else {
        creds = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'gcal-creds.json'), 'utf8'));
      }

      const jwt = new google.auth.JWT(
        creds.client_email,
        null,
        creds.private_key,
        ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/calendar.events'],
        GOOGLE_IMPERSONATE_USER || undefined
      );
      await jwt.authorize();
      const calendar = google.calendar({ version: 'v3', auth: jwt });

      const insertRes = await calendar.events.insert({
        calendarId: calendar_id,
        resource: calendar_event,
        sendUpdates: 'all' // adjust as desired: 'none'|'externalOnly'|'all'
      });

      return res.json({ ok: true, event: insertRes.data });
    }

    return res.status(501).json({ error: 'not_implemented', message: 'No calendar booking implementation available' });
  } catch (err) {
    console.error('book error:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server_error', message: err && err.message ? err.message : 'Failed to book appointment' });
  }
});

// Health check
router.get('/health', (_req, res) => res.json({ ok: true, timestamp: new Date().toISOString() }));

module.exports = router;

// If run directly, mount router to a new app and listen
if (require.main === module) {
  const app = express();
  const PORT = Number(process.env.PORT || 8080);

  // parse JSON bodies
  app.use(express.json({ limit: '256kb' }));

  // try to mount the separate book router if it exists (optional)
  try {
    const bookRouter = require('./routes/book_provider_appointment');
    app.use(bookRouter);
    console.log('Mounted ./routes/book_provider_appointment (standalone mode)');
  } catch (e) {
    // not fatal — the bundled /book endpoint above will still work
    console.log('No ./routes/book_provider_appointment module found (optional).');
  }

  // mount the main router for all the endpoints exported above
  app.use('/', router);

  app.listen(PORT, () => {
    console.log(`GoogleCalendarWebhook (router) listening on port ${PORT}`);
    console.log(`📅 Timezone: ${DEFAULT_TIMEZONE}`);
    console.log(`🔐 Auth: ${SECRET_TOKEN ? 'Enabled' : 'DISABLED (Warning!)'}`);
  });
}