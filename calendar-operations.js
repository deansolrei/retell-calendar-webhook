'use strict';
/**
 * Calendar operations + small parsing helpers.
 *
 * Exports:
 *  - get_provider_availability
 *  - get_calendar_slots
 *  - book_provider_appointment
 *  - parse_patient_name
 *  - parse_provider_name
 *
 * Uses googleapis/luxon where needed.
 */

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { DateTime, Interval } = require('luxon');

// default config
const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || 'America/New_York';
const DEFAULT_REQUIRED_FREE_MINUTES = Number(process.env.DEFAULT_REQUIRED_FREE_MINUTES || 30);

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

// Utilities to compute free time slots
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

// --------------------- parsing helpers ---------------------

// parse_patient_name: accepts payload with user_message or name string
function splitName(raw) {
  if (!raw || !String(raw).trim()) return { full_name: "", first_name: "", last_name: "" };
  const s = String(raw).trim();
  const suffixRegex = /\b(Jr\.|Sr\.|II|III|IV)\b\.?$/i;
  const orig = s;
  const noSuffix = s.replace(suffixRegex, '').trim();
  const parts = noSuffix.split(/\s+/);
  const first = parts.length ? parts[0] : "";
  const last = parts.length > 1 ? parts[parts.length - 1] : "";
  return { full_name: orig, first_name: first, last_name: last };
}

async function parse_patient_name(payload) {
  const raw = (payload && (payload.user_message || payload.text || payload.patient_name)) || '';
  return splitName(raw);
}

// parse_provider_name: attempt to map a freeform name/token/email to a known provider
function loadProviders() {
  // prefer providers.js if present (exposes helper functions), else providers.json
  try {
    const pmod = require('./providers');
    if (pmod && typeof pmod.getProviders === 'function') {
      return pmod.getProviders();
    }
    // if providers.js exports an object
    if (pmod && typeof pmod === 'object' && Object.keys(pmod).length) return pmod;
  } catch (e) {
    // try JSON file fallback
    try {
      const js = require('./providers.json');
      return js;
    } catch (e2) {
      return {};
    }
  }
  return {};
}

async function parse_provider_name(payload) {
  const raw = (payload && (payload.provider_display_name || payload.user_message || payload.text)) || '';
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return { provider_name: '', provider_token: '', provider_calendar_id: '' };

  const providers = loadProviders();

  // Normalize providers shape: accept map-of-key -> { token, calendar_id, name }
  const list = [];
  for (const k of Object.keys(providers)) {
    const p = providers[k];
    // if providers.json is keyed by tokens, preserve token key
    const token = (p && (p.token || k)) || k;
    const name = (p && p.name) || token;
    const cal = (p && p.calendar_id) || '';
    list.push({ token: String(token).toLowerCase(), name: String(name).toLowerCase(), calendar_id: String(cal).toLowerCase(), displayName: (p && p.name) || name });
  }

  // negatives
  const negatives = ["don't have", "dont have", "no provider", "nope", "none", "no"];
  for (const n of negatives) if (s.includes(n)) return { provider_name: '', provider_token: '', provider_calendar_id: '' };

  // try exact token / email match, contains, name parts, local calendar prefix
  for (const p of list) {
    if (s === p.token || s === p.calendar_id) {
      return { provider_name: p.displayName || p.token, provider_token: p.token, provider_calendar_id: p.calendar_id };
    }
  }
  for (const p of list) {
    if (s.includes(p.token) || (p.name && s.includes(p.name))) {
      return { provider_name: p.displayName || p.token, provider_token: p.token, provider_calendar_id: p.calendar_id };
    }
    const nameParts = p.name ? p.name.split(/\s+/).filter(Boolean) : [];
    for (const np of nameParts) {
      if (np && s.includes(np)) {
        return { provider_name: p.displayName || p.token, provider_token: p.token, provider_calendar_id: p.calendar_id };
      }
    }
    if (p.calendar_id) {
      const calLocal = p.calendar_id.split('@')[0];
      if (calLocal && s.includes(calLocal)) {
        return { provider_name: p.displayName || p.token, provider_token: p.token, provider_calendar_id: p.calendar_id };
      }
    }
  }

  // fallback: echo user input
  return { provider_name: raw || '', provider_token: '', provider_calendar_id: '' };
}

module.exports = {
  get_provider_availability,
  get_calendar_slots,
  book_provider_appointment,
  parse_patient_name,
  parse_provider_name,
  DEFAULT_TIMEZONE,
  DEFAULT_REQUIRED_FREE_MINUTES
};
