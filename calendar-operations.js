'use strict';
/**
 * Calendar operations and helpers.
 *
 * Exports:
 *  - get_provider_availability: Fetches available slots for a provider's calendar.
 *  - get_calendar_slots: Organizes available calendar slots for the user.
 *  - book_provider_appointment: Schedules an appointment on the provider's calendar.
 *
 * Uses googleapis and luxon libraries for handling calendar and date utilities.
 */

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { DateTime, Interval } = require('luxon');

// Default configuration
const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || 'America/New_York';
const DEFAULT_REQUIRED_FREE_MINUTES = Number(process.env.DEFAULT_REQUIRED_FREE_MINUTES || 30);

/**
 * getJwtAuth: Authenticates Google APIs using a service account and impersonation.
 * - Supports environment variables, manual input, and local JSON files.
 */
async function getJwtAuth(googleCredsEnv, impersonateUser) {
  let creds = null;

  // Priority 1: Explicit parameter
  if (googleCredsEnv && String(googleCredsEnv).trim()) {
    try {
      creds = typeof googleCredsEnv === 'string' ? JSON.parse(googleCredsEnv) : googleCredsEnv;
    } catch (e) {
      console.error('getJwtAuth: Failed to parse googleCredsEnv param JSON:', e.message || e);
    }
  }

  // Priority 2: Environment variables
  if (!creds) {
    const envCreds = process.env.GOOGLE_CREDS || process.env.GCAL_KEY_JSON || null;
    if (envCreds && String(envCreds).trim()) {
      try {
        creds = typeof envCreds === 'string' ? JSON.parse(envCreds) : envCreds;
      } catch (e) {
        console.error('getJwtAuth: Failed to parse env JSON for GOOGLE_CREDS/GCAL_KEY_JSON:', e.message || e);
      }
    }
  }

  // Priority 3: Local file fallback
  if (!creds) {
    const filePath = path.join(process.cwd(), 'gcal-creds.json');
    if (!fs.existsSync(filePath)) {
      throw new Error('getJwtAuth: Google credentials not found in env variables or gcal-creds.json');
    }
    try {
      creds = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      throw new Error('getJwtAuth: File gcal-creds.json parsing failed:', e.message || String(e));
    }
  }

  // Perform JWT setup with impersonation
  const scopes = ['https://www.googleapis.com/auth/calendar'];
  const subject = impersonateUser || process.env.GOOGLE_IMPERSONATE_USER;

  if (!subject) {
    throw new Error('getJwtAuth: impersonateUser or GOOGLE_IMPERSONATE_USER must be provided.');
  }

  const jwt = new google.auth.JWT(
    creds.client_email, // Service account email
    null, // No key file path needed (using key directly)
    creds.private_key,  // Service account private key
    scopes,   // Required Calendar API scopes
    subject   // The user to impersonate
  );

  await jwt.authorize();
  return jwt;
}

/**
 * mergeBusyIntervals: Merges overlapping or adjacent busy intervals into a clean list.
 */
function mergeBusyIntervals(events, tz) {
  const intervals = events
    .map(({ start, end }) => {
      const s = start?.dateTime || start?.date;
      const e = end?.dateTime || end?.date;
      if (!s || !e) return null; // Skip invalid entries
      const startTime = DateTime.fromISO(s, { zone: tz });
      const endTime = DateTime.fromISO(e, { zone: tz });
      return startTime.isValid && endTime.isValid ? Interval.fromDateTimes(startTime, endTime) : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);

  if (!intervals.length) return [];
  const merged = [];
  let current = intervals[0];

  for (const next of intervals) {
    if (current.overlaps(next) || current.abutsStart(next)) {
      current = Interval.fromDateTimes(current.start, current.end > next.end ? current.end : next.end);
    } else {
      merged.push(current);
      current = next;
    }
  }
  merged.push(current);
  return merged;
}

/**
 * computeFreeSlots: Computes available time slots within a given time window.
 */
function computeFreeSlots(busyIntervals, windowInterval, slotMinutes) {
  const slots = [];
  let cursor = windowInterval.start;

  for (const busy of busyIntervals) {
    if (busy.end <= cursor) continue;
    if (busy.start > cursor) {
      let availStart = cursor;
      while (availStart.plus({ minutes: slotMinutes }) <= busy.start) {
        const availEnd = availStart.plus({ minutes: slotMinutes });
        slots.push({
          start: availStart.toISO(),
          end: availEnd.toISO(),
          timeZone: windowInterval.start.zoneName,
        });
        availStart = availEnd;
      }
    }
    cursor = busy.end > cursor ? busy.end : cursor;
  }

  while (cursor.plus({ minutes: slotMinutes }) <= windowInterval.end) {
    const start = cursor;
    const end = cursor.plus({ minutes: slotMinutes });
    slots.push({
      start: start.toISO(),
      end: end.toISO(),
      timeZone: windowInterval.start.zoneName,
    });
    cursor = end;
  }
  return slots;
}

/**
 * listEvents: Fetches events from a Google Calendar within a specific time range.
 */
async function listEvents(calendar, calendarId, timeMinISO, timeMaxISO) {
  const result = await calendar.events.list({
    calendarId,
    singleEvents: true,
    orderBy: 'startTime',
    timeMin: timeMinISO,
    timeMax: timeMaxISO,
    maxResults: 2500,
  });
  return result.data.items || [];
}

/**
 * Slots and Availability APIs
 */
async function get_provider_availability({ calendarId, requested_date, slotDurationMinutes = DEFAULT_REQUIRED_FREE_MINUTES, days_to_check = 1, user_timezone = DEFAULT_TIMEZONE }, googleCredsEnv, impersonateUser) {
  const jwt = await getJwtAuth(googleCredsEnv, impersonateUser);
  const calendar = google.calendar({ version: 'v3', auth: jwt });
  const start = DateTime.fromISO(requested_date, { zone: user_timezone });
  const end = start.plus({ days: days_to_check });
  const events = await listEvents(calendar, calendarId, start.toISO(), end.toISO());
  const busyIntervals = mergeBusyIntervals(events, user_timezone);
  return computeFreeSlots(busyIntervals, Interval.fromDateTimes(start, end), slotDurationMinutes);
}

module.exports = { getJwtAuth, mergeBusyIntervals, listEvents, get_provider_availability };