/**
 * main.js
 * Improved server with extra debug logging and safer handling of missing/placeholder dates.
 *
 * Changes included:
 * - /book handler logs headers and body immediately for debugging.
 * - /book returns clearer 400 responses listing which fields are missing.
 * - /availability and /book both try to recover a date if it's accidentally placed in query params
 *   (this helps when the Retell UI or a stale test injects a date as a query string like
 *   "?Default+%2F+Value=2024-07-31").
 * - Slightly more defensive parsing and extra logs to speed debugging.
 *
 * Deploy with:
 *   gcloud builds submit --tag gcr.io/$(gcloud config get-value project)/retell-calendar-api .
 *   gcloud run deploy retell-calendar-api --image gcr.io/$(gcloud config get-value project)/retell-calendar-api --region us-central1 --platform managed --update-env-vars SECRET_TOKEN=retell_secret_2025 --allow-unauthenticated
 */

const express = require('express');
const { google } = require('googleapis');
const { DateTime } = require('luxon'); // timezone-aware dates
const fs = require('fs');

const app = express();
app.use(express.json());

// Initialize Google Calendar client
let calendar;

async function initializeCalendar() {
  try {
    let credentials;

    if (process.env.GOOGLE_CREDS) {
      console.log('Using GOOGLE_CREDS from environment');
      credentials = JSON.parse(process.env.GOOGLE_CREDS);
    } else if (process.env.GOOGLE_CREDS_BASE64) {
      console.log('Using GOOGLE_CREDS_BASE64 from environment');
      const decoded = Buffer.from(process.env.GOOGLE_CREDS_BASE64, 'base64').toString('utf-8');
      credentials = JSON.parse(decoded);
    } else if (fs.existsSync('./credentials.json')) {
      console.log('Using credentials.json file');
      credentials = require('./credentials.json');
    } else {
      throw new Error('No Google credentials found (GOOGLE_CREDS, GOOGLE_CREDS_BASE64, or credentials.json)');
    }

    const auth = new google.auth.GoogleAuth({
      credentials: credentials,
      scopes: ['https://www.googleapis.com/auth/calendar']
    });

    const authClient = await auth.getClient();
    calendar = google.calendar({ version: 'v3', auth: authClient });

    console.log('Google Calendar initialized successfully');
  } catch (err) {
    console.error('Failed to initialize Google Calendar:', err);
    throw err;
  }
}

// Helper: try to extract a plausible YYYY-MM-DD date string from many places (body or query values)
function extractDateFromRequest(req) {
  // 1) prefer req.body.date if provided
  if (req.body && typeof req.body.date === 'string' && req.body.date.trim() !== '') {
    return req.body.date.trim();
  }

  // 2) check query params for any value that looks like YYYY-MM-DD (handles url-encoded "Default / Value" style)
  const q = req.query || {};
  for (const key of Object.keys(q)) {
    const v = String(q[key] || '').trim();
    // simple ISO date pattern match YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    // if query value contains a date substring, try to extract it
    const m = v.match(/(20\d{2}-\d{2}-\d{2})/);
    if (m) return m[1];
  }

  // 3) fallback: no date found
  return null;
}

// Health check
app.get('/', (req, res) => {
  res.send('Retell AI → Google Calendar API is alive');
});

/**
 * Availability endpoint (timezone-aware)
 * - Logs incoming request body for debugging.
 * - If date is missing or placeholder, attempts to recover from query params, then falls back to today's date in America/New_York.
 * - Computes window and slots in America/New_York, returns slot times as UTC ISO strings.
 */
app.post('/availability', async (req, res) => {
  try {
    // Auth header check
    const authHeader = req.get('Authorization') || req.get('authorization') || '';
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = authHeader.substring(7);
    if (token !== process.env.SECRET_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Read body and log it for debugging
    let { calendar_id, date } = req.body || {};
    console.log('Incoming /availability headers:', JSON.stringify(req.headers || {}));
    console.log('Incoming /availability body:', JSON.stringify(req.body || {}));
    // If date missing in body, try to extract it from query params (fix for UI putting date in querystring)
    if (!date || (typeof date === 'string' && date.trim() === '')) {
      const found = extractDateFromRequest(req);
      if (found) {
        console.warn('Date not in body; recovered date from query or params:', found);
        date = found;
      }
    }

    // Test fallback: if still no date or placeholder, default to today's date in Eastern
    if (!date || date === '<CALENDAR_ID>' || (typeof date === 'string' && date.trim() === '')) {
      const todayEastern = DateTime.now().setZone('America/New_York').toISODate();
      console.warn('No date provided or placeholder detected; defaulting to', todayEastern);
      date = todayEastern;
    }

    if (!calendar) {
      return res.status(503).json({ error: 'Calendar service not initialized' });
    }

    // Validate date (basic)
    if (!date || typeof date !== 'string') {
      return res.status(400).json({ error: 'Missing required field: date' });
    }

    // Query params: start_hour, end_hour, slot_duration (minutes)
    const q = req.query || {};
    const parseNumber = (v) => {
      if (v === undefined || v === null || v === '') return NaN;
      const n = Number(v);
      return Number.isFinite(n) ? n : NaN;
    };
    const startHourRaw = parseNumber(q.start_hour);
    const endHourRaw = parseNumber(q.end_hour);
    const slotDurationRaw = parseNumber(q.slot_duration);

    const startHour = Number.isFinite(startHourRaw) ? Math.max(0, Math.min(23, startHourRaw)) : 9;
    const endHour = Number.isFinite(endHourRaw) ? Math.max(0, Math.min(23, endHourRaw)) : 17;
    const slotDurationMinutes = Number.isFinite(slotDurationRaw) ? Math.max(1, slotDurationRaw) : 60;

    if (endHour <= startHour) {
      return res.status(400).json({ error: 'end_hour must be greater than start_hour' });
    }

    // Timezone handling: interpret date and window in Eastern Time
    const tz = 'America/New_York';
    let dt = DateTime.fromISO(date, { zone: tz });
    if (!dt.isValid) {
      dt = DateTime.fromFormat(date, 'yyyy-MM-dd', { zone: tz });
    }
    if (!dt.isValid) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD or ISO 8601.' });
    }

    // Start and end of day in Eastern
    const startOfDayEastern = dt.startOf('day');
    const endOfDayEastern = dt.endOf('day');

    // Window start/end in Eastern
    const windowStartEastern = startOfDayEastern.plus({ hours: startHour });
    const windowEndEastern = startOfDayEastern.plus({ hours: endHour });

    // Query Google Calendar for the full day range (converted to UTC)
    const timeMin = startOfDayEastern.toUTC().toISO();
    const timeMax = endOfDayEastern.toUTC().toISO();

    const response = await calendar.events.list({
      calendarId: calendar_id || 'primary',
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime'
    });

    const events = response.data.items || [];

    // Helper: parse event date/time robustly into luxon DateTime (UTC)
    const parseEventDateTime = (evTime) => {
      if (!evTime) return null;
      const asVal = evTime.dateTime || evTime.date;
      if (!asVal) return null;
      // Try parsing ISO; if it's a date (all-day), parse as UTC midnight
      let parsed = DateTime.fromISO(asVal, { zone: 'utc' });
      if (!parsed.isValid) {
        parsed = DateTime.fromFormat(asVal, 'yyyy-MM-dd', { zone: 'utc' });
      }
      return parsed.isValid ? parsed : null;
    };

    // compute slots
    const totalMinutesWindow = (endHour - startHour) * 60;
    const slotCount = Math.ceil(totalMinutesWindow / slotDurationMinutes);
    const slots = [];

    // Now (Eastern) used to filter out past slots
    const nowEastern = DateTime.now().setZone(tz);

    for (let i = 0; i < slotCount; i++) {
      const slotStartEastern = windowStartEastern.plus({ minutes: i * slotDurationMinutes });
      const slotEndEastern = slotStartEastern.plus({ minutes: slotDurationMinutes });

      if (slotStartEastern >= windowEndEastern) break;
      if (slotEndEastern > windowEndEastern) continue;

      // Skip past slots
      if (slotStartEastern <= nowEastern) continue;

      const slotStartUTC = slotStartEastern.toUTC();
      const slotEndUTC = slotEndEastern.toUTC();

      const isAvailable = !events.some(event => {
        const evStart = parseEventDateTime(event.start);
        const evEnd = parseEventDateTime(event.end);
        if (!evStart || !evEnd) return false;
        return (slotStartUTC < evEnd && slotEndUTC > evStart);
      });

      if (isAvailable) {
        slots.push({
          start_iso: slotStartUTC.toISO(),
          end_iso: slotEndUTC.toISO(),
          available: true
        });
      }
    }

    return res.json({
      date: startOfDayEastern.toISO().slice(0, 10),
      calendar_id: calendar_id || 'primary',
      requested_window: { start_hour: startHour, end_hour: endHour, slot_duration_minutes: slotDurationMinutes },
      slots
    });
  } catch (err) {
    console.error('Error checking availability:', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Booking endpoint (timezone-aware: interprets date and times as America/New_York)
 * - Immediately logs headers and body so we can see exactly what the agent sent.
 * - Tries to recover date if it was accidentally placed in query params.
 * - Returns clear 400 responses listing missing/invalid fields for faster debugging.
 */
app.post('/book', async (req, res) => {
  try {
    // Log headers & body immediately for debugging (very helpful for Retell UI issues)
    console.log('Incoming /book headers:', JSON.stringify(req.headers || {}));
    console.log('Incoming /book body:', JSON.stringify(req.body || {}));
    // Also log the raw URL (to see any stray query params)
    console.log('Incoming /book url:', req.originalUrl || req.url || '');

    // Auth header check
    const authHeader = req.get('Authorization') || req.get('authorization') || '';
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = authHeader.substring(7);
    if (token !== process.env.SECRET_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Accept date/start_time/end_time either from body or, as a fallback, try extracting date from query params
    const fallbackDate = extractDateFromRequest(req); // will look at query params if body missing
    const { calendar_id, date: bodyDate, start_time, end_time, attendee_name, attendee_email } = req.body || {};
    const date = (bodyDate && String(bodyDate).trim() !== '') ? bodyDate : fallbackDate;

    // Report which fields are missing (clear message)
    const missing = [];
    if (!date) missing.push('date');
    if (!start_time) missing.push('start_time');
    if (!end_time) missing.push('end_time');

    if (!calendar) {
      return res.status(503).json({ error: 'Calendar service not initialized' });
    }

    if (missing.length > 0) {
      // return a clear 400 explaining which fields are missing
      const msg = `Missing required fields: ${missing.join(', ')}`;
      console.warn(msg, { bodyDate, start_time, end_time, fallbackDate, query: req.query });
      return res.status(400).json({ error: msg, received: { bodyDate, start_time, end_time, fallbackDate } });
    }

    const tz = 'America/New_York';

    // parse HH:MM
    const [sh, sm] = (String(start_time || '00:00')).split(':').map(s => Number(s));
    const [eh, em] = (String(end_time || '00:00')).split(':').map(s => Number(s));

    if (Number.isNaN(sh) || Number.isNaN(eh)) {
      return res.status(400).json({ error: 'Invalid time format, expected HH:MM' });
    }

    // Build DateTimes in Eastern
    let startDT = DateTime.fromISO(date, { zone: tz }).set({ hour: sh, minute: sm || 0, second: 0, millisecond: 0 });
    let endDT = DateTime.fromISO(date, { zone: tz }).set({ hour: eh, minute: em || 0, second: 0, millisecond: 0 });

    if (!startDT.isValid || !endDT.isValid) {
      const d = DateTime.fromFormat(date, 'yyyy-MM-dd', { zone: tz });
      if (!d.isValid) return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD or ISO.' });
      startDT = d.set({ hour: sh, minute: sm || 0, second: 0, millisecond: 0 });
      endDT = d.set({ hour: eh, minute: em || 0, second: 0, millisecond: 0 });
    }

    const event = {
      summary: `Appointment with ${attendee_name || 'Client'}`,
      start: {
        dateTime: startDT.toISO(), // includes offset like -04:00
        timeZone: tz
      },
      end: {
        dateTime: endDT.toISO(),
        timeZone: tz
      },
      attendees: attendee_email ? [{ email: attendee_email }] : []
    };

    const response = await calendar.events.insert({
      calendarId: calendar_id || 'primary',
      resource: event
    });

    res.json({
      success: true,
      event_id: response.data.id,
      event_link: response.data.htmlLink
    });
  } catch (error) {
    console.error('Error booking appointment:', error && error.stack ? error.stack : error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start server
const PORT = process.env.PORT || 8080;

async function startServer() {
  try {
    await initializeCalendar();
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err && err.stack ? err.stack : err);
    process.exit(1);
  }
}

startServer();