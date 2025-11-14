/**
 * GoogleCalendarWebhook.js - Cleaned server file
 *
 * - Uses calendar-operations.js for scheduling logic (must exist in same folder)
 * - Provides endpoints:
 *    POST /availability  -> returns available slots (and backward-compatible slotN_* keys)
 *    POST /book          -> creates a Google Calendar event (expects start/end ISO strings)
 * - Protects endpoints with SECRET_TOKEN via Authorization: Bearer <token>
 * - Uses a service account and domain-wide delegation to impersonate a workspace user when creating events
 *
 * Requirements:
 *  - npm packages: express, googleapis, luxon
 *  - calendar-operations.js in same project (as provided earlier)
 *
 * Drop this file into your project and adjust any small NAME/ENV differences as needed.
 */

'use strict';

const express = require('express');
const { google } = require('googleapis');
const { DateTime } = require('luxon');
// --- START DIAGNOSTIC SNIPPET ---
// Place this block immediately before:
//    const calendarOps = require('./calendar-operations');
const fs = require('fs');
const path = require('path');
console.log('DIAG: cwd=', process.cwd(), '__dirname=', __dirname);
const expected = path.join(__dirname, 'calendar-operations.js');
console.log('DIAG: expected module path:', expected, 'exists=', fs.existsSync(expected));
try {
  console.log('DIAG: require.resolve result:', require.resolve('./calendar-operations'));
} catch (err) {
  console.log('DIAG: require.resolve failed:', err && err.message ? err.message : err);
}
// --- END DIAGNOSTIC SNIPPET ---
const calendarOps = require('./calendar-operations');

const app = express();
app.use(express.json({ limit: '256kb' }));

// Configuration (environment-variable overrides)
const PORT = Number(process.env.PORT || 8080);
const SECRET_TOKEN = process.env.SECRET_TOKEN || ''; // expected token (no "Bearer ")
const GOOGLE_CREDS_ENV = process.env.GOOGLE_CREDS || process.env.GCAL_KEY_JSON || null;
const GOOGLE_IMPERSONATE_USER = process.env.GOOGLE_IMPERSONATE_USER || process.env.GCAL_SUBJECT || null;

// default behavior values (fallback to calendarOps constants)
const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || calendarOps.DEFAULT_TIMEZONE;
const DEFAULT_REQUIRED_FREE_MINUTES = Number(process.env.DEFAULT_REQUIRED_FREE_MINUTES || calendarOps.DEFAULT_REQUIRED_FREE_MINUTES);
const DEFAULT_DAYS_TO_CHECK = Number(process.env.DAYS_TO_CHECK_AHEAD || 7);

// Helper: validate incoming bearer token
function checkAuthBearer(req) {
  const auth = req.headers.authorization || '';
  if (!SECRET_TOKEN) return true; // if unset, don't enforce (use cautiously)
  return auth === `Bearer ${SECRET_TOKEN}`;
}

// Initialize Google Calendar client (JWT with optional impersonation)
async function getCalendarClient() {
  // Uses cached client if created already
  if (getCalendarClient._cached) return getCalendarClient._cached;

  if (!GOOGLE_CREDS_ENV) {
    throw new Error('Missing service account credentials (set GOOGLE_CREDS or GCAL_KEY_JSON env)');
  }

  let creds;
  if (typeof GOOGLE_CREDS_ENV === 'string') {
    try {
      creds = JSON.parse(GOOGLE_CREDS_ENV);
    } catch (e) {
      // If GOOGLE_CREDS_ENV is a JSON string stored in Secret, parse it
      throw new Error('Invalid GOOGLE_CREDS/GCAL_KEY_JSON: not valid JSON');
    }
  } else {
    throw new Error('GOOGLE_CREDS env var not accessible');
  }

  const subject = GOOGLE_IMPERSONATE_USER || null;
  const jwt = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/calendar.events'
    ],
    subject
  );

  await jwt.authorize();
  const calendarClient = google.calendar({ version: 'v3', auth: jwt });

  getCalendarClient._cached = calendarClient;
  return calendarClient;
}

// Utility: respond with 401 if unauthorized
function requireAuth(req, res) {
  if (!checkAuthBearer(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

/**
 * POST /availability
 * Body:
 *   { calendar_id, date, days_to_check, user_timezone, required_free_minutes, max_slots }
 *
 * Returns:
 *   {
 *     available_slots: [ { date, start_iso_et, end_iso_et, start_iso_user, end_iso_user, display }, ... ],
 *     // backward-compatible keys: slot1_start_iso, slot1_end_iso, slot1_label, ...
 *   }
 */
app.post('/availability', async (req, res) => {
  try {
    if (!requireAuth(req, res)) return;

    const body = req.body || {};
    const calendarId = body.calendar_id || body.calendarId;
    if (!calendarId) {
      return res.status(400).json({ error: 'Missing calendar_id' });
    }

    // requested date or today
    const dateStr = body.date || DateTime.now().setZone(DEFAULT_TIMEZONE).toISODate();
    const daysToCheck = Number(body.days_to_check || body.daysToCheck || DEFAULT_DAYS_TO_CHECK);
    const userTimezone = body.user_timezone || body.userTimezone || null;
    const requiredFreeMinutes = Number(body.required_free_minutes || body.requiredFreeMinutes || DEFAULT_REQUIRED_FREE_MINUTES);
    const maxSlots = Number(body.max_slots || body.maxSlots || 4);

    const calendar = await getCalendarClient();

    const slots = await calendarOps.findAvailableSlotsMultiDay(
      calendar,
      calendarId,
      dateStr,
      daysToCheck,
      {
        maxSlots,
        requiredFreeMinutes,
        userTimezone
      }
    );

    // Build response and also include backward-compatible slotN keys used by the Retell flow
    const response = { available_slots: slots };

    // map up to 8 slots into slot1_start_iso, slot1_end_iso, slot1_label
    for (let i = 0; i < Math.min(8, slots.length); i++) {
      const s = slots[i];
      const n = i + 1;
      response[`slot${n}_start_iso`] = s.start_iso_et;
      response[`slot${n}_end_iso`] = s.end_iso_et;
      response[`slot${n}_label`] = calendarOps.formatSlotLabel(s);
    }

    return res.json(response);
  } catch (err) {
    console.error('Error in /availability:', err && err.message ? err.message : err);
    return res.status(500).json({ error: 'Failed to fetch availability', details: err?.message || String(err) });
  }
});

/**
 * POST /book
 * Body options (preferred):
 *   { calendar_id, start, end, attendee_name, attendee_email, send_confirmation }
 *
 * Alternative: client may send user-local start + userTimezone + booked_minutes
 *   { calendar_id, user_start_iso, user_timezone, booked_minutes, attendee_name, attendee_email, send_confirmation }
 *
 * Authorization: must pass Authorization: Bearer <SECRET_TOKEN>
 */
app.post('/book', async (req, res) => {
  try {
    if (!requireAuth(req, res)) return;

    const body = req.body || {};
    const calendarId = body.calendar_id || body.calendarId;
    if (!calendarId) return res.status(400).json({ error: 'Missing calendar_id' });

    let startIso = body.start || body.start_iso || null;
    let endIso = body.end || body.end_iso || null;

    // If user provided a user-local start and booked_minutes, convert to Eastern time range
    if ((!startIso || !endIso) && body.user_start_iso) {
      const bookedMinutes = Number(body.booked_minutes || body.bookedMinutes || calendarOps.MAX_BOOKED_MINUTES);
      const conv = calendarOps.convertUserSelectionToEastern(body.user_start_iso, body.user_timezone || body.userTimezone || null, bookedMinutes);
      startIso = conv.start_iso_et;
      endIso = conv.end_iso_et;
    }

    // If still missing required start/end, error
    if (!startIso || !endIso) {
      return res.status(400).json({ error: 'Missing start and end. Provide start and end (ISO) or user_start_iso + booked_minutes.' });
    }

    // normalize ISO strings (ensure luxon accepts them)
    try {
      // Keep them as-is because Google accepts ISO with offsets; ensure they parse
      DateTime.fromISO(startIso); DateTime.fromISO(endIso);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid start or end ISO format' });
    }

    const attendeeName = body.attendee_name || body.attendeeName || body.name || null;
    const attendeeEmail = body.attendee_email || body.attendeeEmail || body.email || null;
    const sendConfirmation = (typeof body.send_confirmation !== 'undefined') ? Boolean(body.send_confirmation) : false;

    // Create event object
    const event = {
      summary: `Appointment${attendeeName ? ' with ' + attendeeName : ''}`,
      description: (body.description || '').toString().slice(0, 2000),
      start: { dateTime: startIso },
      end: { dateTime: endIso }
    };

    if (attendeeEmail) {
      event.attendees = [{ email: attendeeEmail }];
    }

    const calendar = await getCalendarClient();

    // Insert event
    const insertParams = {
      calendarId,
      requestBody: event
    };

    // If sendConfirmation true, use sendUpdates:'all' to notify guests
    if (sendConfirmation) {
      insertParams.sendUpdates = 'all';
    }

    const insertRes = await calendar.events.insert(insertParams);

    const created = insertRes?.data || {};
    return res.json({
      success: true,
      event_id: created.id || null,
      event_link: created.htmlLink || null,
      summary: created.summary || event.summary,
      start: startIso,
      end: endIso,
      confirmation_sent: !!sendConfirmation
    });
  } catch (err) {
    console.error('Error in /book:', err && err.response ? err.response.data : err.message || err);
    // Detect DWD-ish errors and return helpful message
    const message = err?.response?.data || err?.message || String(err);
    if (typeof message === 'string' && message.includes('Service accounts cannot invite attendees')) {
      return res.status(400).json({ error: 'Service accounts cannot invite attendees without Domain-Wide Delegation of Authority.' });
    }
    return res.status(500).json({ error: 'Failed to book appointment', details: message });
  }
});

// Health
app.get('/health', (_req, res) => res.json({ ok: true }));

// Start server
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`GoogleCalendarWebhook listening on port ${PORT}`);
  });
}

module.exports = app;