/**
 * GoogleCalendarWebhook.js (timezone-aware, luxon-backed)
 *
 * Improved Express webhook for:
 *  - /availability : compute free slots for a given calendar/time window (timezone-aware)
 *  - /book         : create an event on a given calendar
 *
 * Enhancements in this version:
 *  - Uses luxon for correct timezone handling across US timezones.
 *  - Uses Calendar FreeBusy API (calendar.freebusy.query) to get busy intervals reliably.
 *  - Advanced free/busy merging + slot scanning with configurable alignment.
 *  - Respects calendar timezone when available; falls back to DEFAULT_TIMEZONE env var.
 *  - More robust payload calendarId resolution.
 *
 * Environment variables:
 *  - GOOGLE_CREDS (preferred) OR GCAL_SERVICE_ACCOUNT_KEY : JSON text of a Google service-account key
 *  - SECRET_TOKEN : token expected in Authorization: Bearer <token>
 *  - DEFAULT_TIMEZONE (optional) : e.g. "America/New_York" (defaults to "UTC")
 *  - SLOT_DURATION_MINUTES (optional) : slot length in minutes (default 60)
 *  - SLOT_ALIGNMENT_MINUTES (optional) : alignment grid in minutes (default 15)
 *  - DEFAULT_WORKDAY_START (optional) : hour in 24h (default 09)
 *  - DEFAULT_WORKDAY_END (optional) : hour in 24h (default 17)
 *
 * To install the new dependency:
 *   npm install luxon
 *
 * Drop this file in src/GoogleCalendarWebhook.js and redeploy the Cloud Run service
 * (or run locally) — you don't need to deploy the previously-provided version first.
 */

const express = require('express');
const { google } = require('googleapis');
const { DateTime, Duration, Interval } = require('luxon');

const app = express();
app.use(express.json());

// Config
const PORT = process.env.PORT || 8080;
const SECRET_TOKEN = process.env.SECRET_TOKEN || '';
const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || 'UTC';
const SLOT_DURATION_MINUTES = Number(process.env.SLOT_DURATION_MINUTES) || 60;
const SLOT_ALIGNMENT_MINUTES = Number(process.env.SLOT_ALIGNMENT_MINUTES) || 15;
const DEFAULT_WORKDAY_START = Number(process.env.DEFAULT_WORKDAY_START || 9); // hour
const DEFAULT_WORKDAY_END = Number(process.env.DEFAULT_WORKDAY_END || 17); // hour

// Helper: resolve calendarId from several payload locations
function resolveCalendarId(payload) {
  if (!payload) return 'primary';
  if (payload?.data?.calendarId) return payload.data.calendarId;
  if (payload?.chat?.retell_llm_dynamic_variables?.provider_calendar_id)
    return payload.chat.retell_llm_dynamic_variables.provider_calendar_id;
  if (payload?.chat?.retell_llm_dynamic_variables?.provider_calendarId)
    return payload.chat.retell_llm_dynamic_variables.provider_calendarId;
  // fallback
  return 'primary';
}

// Helper: read credentials JSON from env; prefer GOOGLE_CREDS, fallback to GCAL_SERVICE_ACCOUNT_KEY
function getCredsJsonRaw() {
  return process.env.GOOGLE_CREDS || process.env.GCAL_SERVICE_ACCOUNT_KEY || '';
}

// Google Calendar client caching
let cachedAuth = null;
let cachedCalendarClient = null;
let cachedClientEmail = null;
async function getCalendarClient() {
  if (cachedCalendarClient && cachedAuth) return { calendar: cachedCalendarClient, clientEmail: cachedClientEmail };

  const raw = getCredsJsonRaw();
  if (!raw) {
    const msg = 'Missing GOOGLE_CREDS / GCAL_SERVICE_ACCOUNT_KEY environment variable.';
    console.error(msg);
    throw new Error(msg);
  }

  let creds;
  try {
    creds = JSON.parse(raw);
  } catch (err) {
    console.error('Failed to parse service account JSON from env:', err.message || err);
    throw err;
  }

  const jwt = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    ['https://www.googleapis.com/auth/calendar'],
    null
  );

  await jwt.authorize();

  cachedAuth = jwt;
  cachedCalendarClient = google.calendar({ version: 'v3', auth: jwt });
  cachedClientEmail = creds.client_email;
  console.log('Google Calendar client initialized for', creds.client_email);
  return { calendar: cachedCalendarClient, clientEmail: cachedClientEmail };
}

// Merge overlapping intervals (array of {start: DateTime, end: DateTime})
function mergeIntervals(intervals) {
  if (!intervals || intervals.length === 0) return [];
  const sorted = intervals.slice().sort((a, b) => a.start.toMillis() - b.start.toMillis());
  const merged = [];
  let current = { start: sorted[0].start, end: sorted[0].end };

  for (let i = 1; i < sorted.length; i++) {
    const it = sorted[i];
    if (it.start <= current.end) {
      // overlap or contiguous -> extend
      if (it.end > current.end) current.end = it.end;
    } else {
      merged.push(current);
      current = { start: it.start, end: it.end };
    }
  }
  merged.push(current);
  return merged;
}

// Round up a DateTime to the next multiple of alignmentMinutes
function roundUpToAlignment(dt, alignmentMinutes) {
  const minutes = dt.minute;
  const remainder = minutes % alignmentMinutes;
  if (remainder === 0 && dt.second === 0 && dt.millisecond === 0) return dt;
  const added = alignmentMinutes - remainder;
  return dt.plus({ minutes: added }).startOf('minute').set({ second: 0, millisecond: 0 });
}

// Compute candidate slots within a window and free/busy intervals
// - windowStartDT, windowEndDT: luxon DateTime in provider timezone
// - busyIntervals: merged intervals array [{start: DateTime, end: DateTime}]
// - slotDurationMinutes: integer
// - alignmentMinutes: integer (grid)
function computeFreeSlotsLuxon(windowStartDT, windowEndDT, busyIntervals, slotDurationMinutes, alignmentMinutes) {
  const slots = [];
  const slotDur = Duration.fromObject({ minutes: slotDurationMinutes });

  // Start at rounded up alignment
  let candidate = roundUpToAlignment(windowStartDT, alignmentMinutes);

  while (candidate.plus(slotDur) <= windowEndDT) {
    const candidateEnd = candidate.plus(slotDur);

    // Check if overlaps any busy interval
    let conflict = false;
    for (const iv of busyIntervals) {
      if (candidate < iv.end && iv.start < candidateEnd) {
        conflict = true;
        break;
      }
    }

    if (!conflict) {
      slots.push({ start: candidate.toISO(), end: candidateEnd.toISO() });
    }

    // Move candidate forward by alignment (not by slotDur) so we can produce overlapped-start slots if desired.
    // If you prefer non-overlapping back-to-back slots, advance by slotDur instead.
    candidate = candidate.plus({ minutes: alignmentMinutes });
  }

  return slots;
}

// Freebusy fetcher using Calendar FreeBusy API.
// Returns array of merged busy intervals in the calendarTimezone (DateTime objects)
async function fetchBusyIntervals(calendar, calendarId, timeMinISO, timeMaxISO) {
  // Freebusy expects RFC3339 timestamps. We pass timeMin/timeMax in ISO (UTC)
  const body = {
    timeMin: timeMinISO,
    timeMax: timeMaxISO,
    items: [{ id: calendarId }],
  };

  const fbRes = await calendar.freebusy.query({ requestBody: body });
  // Structure: fbRes.data.calendars[calendarId].busy -> [{start, end}, ...]
  const cal = fbRes?.data?.calendars?.[calendarId];
  const busy = (cal && cal.busy) || [];

  // Convert to DateTime in UTC for now (we'll convert to calendar tz later)
  const intervals = busy.map((b) => ({ start: DateTime.fromISO(b.start), end: DateTime.fromISO(b.end) }));
  // Merge
  const merged = mergeIntervals(intervals.map(i => ({ start: i.start, end: i.end })));
  return merged;
}

// Determine calendar timezone via calendar.get (fallback to DEFAULT_TIMEZONE)
async function getCalendarTimezone(calendar, calendarId) {
  try {
    const res = await calendar.calendars.get({ calendarId });
    if (res && res.data && res.data.timeZone) {
      return res.data.timeZone;
    }
  } catch (err) {
    // ignore - fallback below
  }
  return DEFAULT_TIMEZONE || 'UTC';
}

// Middleware to validate SECRET_TOKEN
function requireSecretToken(req, res, next) {
  try {
    const auth = (req.get('Authorization') || '').trim();
    if (!SECRET_TOKEN) {
      console.warn('WARNING: SECRET_TOKEN not configured. Accepting unauthenticated requests.');
      return next();
    }
    if (!auth) {
      return res.status(401).json({ error: 'Unauthorized: missing Authorization header' });
    }
    const token = auth.replace(/^Bearer\s+/i, '');
    if (token !== SECRET_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return next();
  } catch (err) {
    console.error('Error in requireSecretToken:', err);
    return res.status(500).json({ error: 'internal' });
  }
}

// Health endpoint
app.get('/healthz', (req, res) => res.status(200).json({ ok: true }));

/**
 * /availability
 *
 * Expected payload (examples):
 * {
 *   "type": "test_event",
 *   "data": {
 *     "calendarId": "c_...@group.calendar.google.com",
 *     "start": "2025-11-06T09:00:00-05:00", // optional
 *     "end": "2025-11-06T17:00:00-05:00",   // optional
 *     "slotDurationMinutes": 60,           // optional override
 *     "alignmentMinutes": 15,              // optional override
 *     "workdayStartHour": 9,               // optional override (local)
 *     "workdayEndHour": 17                 // optional override (local)
 *   }
 * }
 */
app.post('/availability', requireSecretToken, async (req, res) => {
  try {
    const payload = req.body || {};
    const calendarId = resolveCalendarId(payload);
    console.log('Resolved calendarId:', calendarId);

    // Get calendar client
    const { calendar, clientEmail } = await getCalendarClient();

    // Determine calendar timezone (try calendar settings)
    const calendarTimeZone = await getCalendarTimezone(calendar, calendarId);
    console.log('Using calendar timezone:', calendarTimeZone);

    // Determine the requested window
    // Priority: payload.data.start/payload.data.end (ISO datetimes) -> requested_date (single-day) -> fallback to today workday
    const data = payload.data || {};
    let startISO = data.start || null;
    let endISO = data.end || null;

    // If requested_date provided (date only), expand to workday in calendar tz
    if (!startISO && data.requested_date) {
      const dateStr = data.requested_date; // e.g. "2025-11-06"
      const startHour = Number(data.workdayStartHour ?? DEFAULT_WORKDAY_START);
      const endHour = Number(data.workdayEndHour ?? DEFAULT_WORKDAY_END);
      // create DateTime in calendar tz
      const startDT = DateTime.fromISO(`${dateStr}T${String(startHour).padStart(2, '0')}:00:00`, { zone: calendarTimeZone });
      const endDT = DateTime.fromISO(`${dateStr}T${String(endHour).padStart(2, '0')}:00:00`, { zone: calendarTimeZone });
      startISO = startDT.toUTC().toISO();
      endISO = endDT.toUTC().toISO();
    }

    // If explicit start/end are given, parse them and convert to UTC-ISO for freebusy
    if (startISO && endISO) {
      // Ensure ISO strings
      const startDT = DateTime.fromISO(startISO, { zone: calendarTimeZone }).isValid ? DateTime.fromISO(startISO) : DateTime.fromISO(startISO, { setZone: true });
      const endDT = DateTime.fromISO(endISO, { zone: calendarTimeZone }).isValid ? DateTime.fromISO(endISO) : DateTime.fromISO(endISO, { setZone: true });
      // We'll pass UTC ISO strings to FreeBusy
      startISO = startDT.toUTC().toISO();
      endISO = endDT.toUTC().toISO();
    }

    // Fallback: use today's workday in calendar tz (local date)
    if (!startISO || !endISO) {
      const nowCal = DateTime.now().setZone(calendarTimeZone);
      const startDT = nowCal.startOf('day').plus({ hours: DEFAULT_WORKDAY_START });
      const endDT = nowCal.startOf('day').plus({ hours: DEFAULT_WORKDAY_END });
      startISO = startDT.toUTC().toISO();
      endISO = endDT.toUTC().toISO();
      console.log('Fallback window used:', startISO, endISO);
    }

    // Slot duration and alignment (allow overrides)
    const slotDuration = Number(data.slotDurationMinutes) || SLOT_DURATION_MINUTES;
    const alignmentMinutes = Number(data.alignmentMinutes) || SLOT_ALIGNMENT_MINUTES;

    // For FreeBusy, query the window (use UTC ISO strings)
    const timeMin = startISO;
    const timeMax = endISO;

    // Fetch busy intervals via freebusy.query
    const busyMergedUTC = await fetchBusyIntervals(calendar, calendarId, timeMin, timeMax);
    console.log('Busy intervals (UTC) count:', busyMergedUTC.length);

    // Convert busy intervals to calendar timezone DateTime objects
    const busyInCalTZ = busyMergedUTC.map(iv => ({
      start: iv.start.setZone(calendarTimeZone),
      end: iv.end.setZone(calendarTimeZone),
    }));

    // Merge again (safety)
    const busyMerged = mergeIntervals(busyInCalTZ);

    console.log('Merged busy intervals (calendar tz):', busyMerged.map(iv => ({ start: iv.start.toISO(), end: iv.end.toISO() })));

    // Build window in calendar timezone for slot scanning
    const windowStart = DateTime.fromISO(timeMin, { zone: 'utc' }).setZone(calendarTimeZone);
    const windowEnd = DateTime.fromISO(timeMax, { zone: 'utc' }).setZone(calendarTimeZone);

    // Optional: apply provider's daily working hours if requested_date provided or workday override sent
    // If the input gave requested_date, we already set start/end to workday window. If not, allow narrowing via data.workdayStartHour / End.
    // We'll clamp to the windowStart/windowEnd already computed.

    // Compute slots using luxon-aware algorithm
    const slots = computeFreeSlotsLuxon(windowStart, windowEnd, busyMerged, slotDuration, alignmentMinutes);

    const resp = {
      date: windowStart.toISODate(),
      calendar_id: calendarId,
      calendar_time_zone: calendarTimeZone,
      requested_window: { startISO: windowStart.toISO(), endISO: windowEnd.toISO(), slot_duration_minutes: slotDuration, alignment_minutes: alignmentMinutes },
      busy_count: busyMerged.length,
      slots,
    };

    return res.status(200).json(resp);
  } catch (err) {
    console.error('Error in /availability:', err && err.message ? err.message : err);
    return res.status(500).json({ error: 'internal', message: String(err && err.message ? err.message : err) });
  }
});

/**
 * /book
 * Creates an event.
 * Payload example:
 * {
 *   "data": {
 *     "calendarId": "...",
 *     "start": "2025-11-06T10:00:00-05:00",
 *     "end": "2025-11-06T11:00:00-05:00",
 *     "summary": "...",
 *     "description": "...",
 *     "attendees": [{ email: "who@example.com" }]
 *   }
 * }
 */
app.post('/book', requireSecretToken, async (req, res) => {
  try {
    const payload = req.body || {};
    const calendarId = resolveCalendarId(payload);
    console.log('Booking calendarId:', calendarId);

    const data = payload.data || {};
    if (!data.start || !data.end) {
      return res.status(400).json({ error: 'missing start/end in payload.data' });
    }

    const { calendar } = await getCalendarClient();

    // Build event resource; accept dateTime or date (all-day)
    const eventResource = {
      summary: data.summary || 'Appointment',
      description: data.description || '',
      start: data.start_date ? { date: data.start_date } : { dateTime: data.start },
      end: data.end_date ? { date: data.end_date } : { dateTime: data.end },
      attendees: data.attendees || undefined,
      reminders: data.reminders || undefined,
    };

    const insertRes = await calendar.events.insert({
      calendarId,
      resource: eventResource,
      sendUpdates: 'none',
    });

    console.log('Event inserted:', insertRes?.data?.id);
    return res.status(200).json({ ok: true, eventId: insertRes?.data?.id, event: insertRes?.data });
  } catch (err) {
    console.error('Error in /book:', err && err.message ? err.message : err);
    return res.status(500).json({ error: 'internal', message: String(err && err.message ? err.message : err) });
  }
});

// Generic error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'internal' });
});

// Start server if invoked directly
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`GoogleCalendarWebhook listening on port ${PORT}`);
    console.log('Using timezone fallback:', DEFAULT_TIMEZONE);
  });
}

module.exports = app;
