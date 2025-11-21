'use strict';
/**
 * Minimal calendar-operations implementation
 * - Exports: get_provider_availability, get_calendar_slots, book_provider_appointment
 * - Auth: reads process.env.GOOGLE_CREDS or ./gcal-creds.json (service account)
 * - Uses googleapis and luxon
 */

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { DateTime, Interval } = require('luxon');

const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || 'America/New_York';
const DEFAULT_REQUIRED_FREE_MINUTES = 30;

async function getJwtAuth(googleCredsEnv, impersonateUser) {
  let creds;
  if (googleCredsEnv && googleCredsEnv.trim()) {
    creds = JSON.parse(googleCredsEnv);
  } else {
    const p = path.join(process.cwd(), 'gcal-creds.json');
    if (!fs.existsSync(p)) throw new Error('No Google creds found in env or gcal-creds.json');
    creds = JSON.parse(fs.readFileSync(p, 'utf8'));
  }

  const jwt = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/calendar.events'],
    impersonateUser || undefined
  );
  await jwt.authorize();
  return jwt;
}

function mergeBusyIntervals(events, tz) {
  const intervals = events
    .map(ev => {
      const s = ev.start?.dateTime || ev.start?.date;
      const e = ev.end?.dateTime || ev.end?.date;
      if (!s || !e) return null;
      const start = DateTime.fromISO(s, { zone: tz });
      const end = DateTime.fromISO(e, { zone: tz });
      if (!start.isValid || !end.isValid) return null;
      return Interval.fromDateTimes(start, end);
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);

  if (!intervals.length) return [];

  const merged = [];
  let cur = intervals[0];
  for (let i = 1; i < intervals.length; i++) {
    const next = intervals[i];
    if (cur.overlaps(next) || cur.abutsStart(next) || next.start <= cur.end) {
      cur = Interval.fromDateTimes(cur.start, cur.end > next.end ? cur.end : next.end);
    } else {
      merged.push(cur);
      cur = next;
    }
  }
  merged.push(cur);
  return merged;
}

function computeFreeSlots(busyIntervals, windowInterval, slotMinutes) {
  const slots = [];
  let cursor = windowInterval.start;
  for (const busy of busyIntervals) {
    if (busy.end <= windowInterval.start) continue;
    if (busy.start >= windowInterval.end) break;

    if (busy.start > cursor) {
      let availStart = cursor;
      let availEnd = busy.start;
      while (availStart.plus({ minutes: slotMinutes }) <= availEnd) {
        const s = availStart;
        const e = availStart.plus({ minutes: slotMinutes });
        slots.push({ start: s.toISO(), end: e.toISO(), timeZone: windowInterval.start.zoneName });
        availStart = availStart.plus({ minutes: slotMinutes });
      }
    }
    if (busy.end > cursor) cursor = busy.end;
  }

  while (cursor.plus({ minutes: slotMinutes }) <= windowInterval.end) {
    const s = cursor;
    const e = cursor.plus({ minutes: slotMinutes });
    slots.push({ start: s.toISO(), end: e.toISO(), timeZone: windowInterval.start.zoneName });
    cursor = cursor.plus({ minutes: slotMinutes });
  }

  return slots;
}

async function listEvents(calendar, calendarId, timeMinISO, timeMaxISO) {
  const res = await calendar.events.list({
    calendarId,
    singleEvents: true,
    orderBy: 'startTime',
    timeMin: timeMinISO,
    timeMax: timeMaxISO,
    maxResults: 2500
  });
  return res.data.items || [];
}

async function get_calendar_slots({ calendarId, requestedDate, slotDurationMinutes = DEFAULT_REQUIRED_FREE_MINUTES, daysToCheck = 1, timezone = DEFAULT_TIMEZONE, googleCredsEnv = null, impersonateUser = null }) {
  const auth = await getJwtAuth(googleCredsEnv || process.env.GOOGLE_CREDS || process.env.GCAL_KEY_JSON, impersonateUser || process.env.GOOGLE_IMPERSONATE_USER);
  const calendar = google.calendar({ version: 'v3', auth });

  const date = requestedDate ? DateTime.fromISO(requestedDate, { zone: timezone }) : DateTime.now().setZone(timezone);
  if (!date.isValid) throw new Error('Invalid requestedDate');

  const slotsByDay = [];

  for (let d = 0; d < daysToCheck; d++) {
    const day = date.plus({ days: d });
    const dayStart = day.set({ hour: 8, minute: 0, second: 0, millisecond: 0 });
    const dayEnd = day.set({ hour: 18, minute: 0, second: 0, millisecond: 0 });

    const timeMinISO = dayStart.toISO();
    const timeMaxISO = dayEnd.toISO();

    const events = await listEvents(calendar, calendarId, timeMinISO, timeMaxISO);
    const busy = mergeBusyIntervals(events, timezone);
    const window = Interval.fromDateTimes(dayStart, dayEnd);
    const slots = computeFreeSlots(busy, window, Number(slotDurationMinutes));
    slotsByDay.push({ date: day.toISODate(), slots });
  }

  return { ok: true, timezone, days: slotsByDay };
}

async function get_provider_availability(opts) {
  return get_calendar_slots(opts);
}

async function book_provider_appointment({ calendarId, event, googleCredsEnv = null, impersonateUser = null, sendUpdates = 'all' }) {
  const auth = await getJwtAuth(googleCredsEnv || process.env.GOOGLE_CREDS || process.env.GCAL_KEY_JSON, impersonateUser || process.env.GOOGLE_IMPERSONATE_USER);
  const calendar = google.calendar({ version: 'v3', auth });
  const insertRes = await calendar.events.insert({
    calendarId,
    resource: event,
    sendUpdates
  });
  return { ok: true, event: insertRes.data };
}

module.exports = {
  get_provider_availability,
  get_calendar_slots,
  book_provider_appointment,
  DEFAULT_TIMEZONE,
  DEFAULT_REQUIRED_FREE_MINUTES
};
