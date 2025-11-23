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

/**
 * getJwtAuth
 * - Accepts googleCredsEnv (JSON string) OR reads process.env.GOOGLE_CREDS or process.env.GCAL_KEY_JSON.
 * - If neither present, falls back to reading gcal-creds.json from disk.
 * - Logs presence and length of client_email/private_key (NOT the secret itself) for debugging.
 */
async function getJwtAuth(googleCredsEnv, impersonateUser) {
  let creds = null;
  let source = null;

  // prefer explicit param
  if (googleCredsEnv && String(googleCredsEnv).trim()) {
    try {
      creds = typeof googleCredsEnv === 'string' ? JSON.parse(googleCredsEnv) : googleCredsEnv;
      source = 'param';
    } catch (e) {
      console.error('getJwtAuth: failed to parse googleCredsEnv param JSON:', e && e.message ? e.message : e);
    }
  }

  // fallback to env var GOOGLE_CREDS or GCAL_KEY_JSON
  if (!creds) {
    const envCreds = process.env.GOOGLE_CREDS || process.env.GCAL_KEY_JSON || null;
    if (envCreds && String(envCreds).trim()) {
      try {
        creds = typeof envCreds === 'string' ? JSON.parse(envCreds) : envCreds;
        source = process.env.GOOGLE_CREDS ? 'GOOGLE_CREDS' : 'GCAL_KEY_JSON';
      } catch (e) {
        console.error('getJwtAuth: failed to parse env JSON for GOOGLE_CREDS/GCAL_KEY_JSON:', e && e.message ? e.message : e);
      }
    }
  }

  // final fallback to local file gcal-creds.json
  if (!creds) {
    const p = path.join(process.cwd(), 'gcal-creds.json');
    if (!fs.existsSync(p)) {
      throw new Error('No Google creds found in env or gcal-creds.json');
    }
    try {
      creds = JSON.parse(fs.readFileSync(p, 'utf8'));
      source = 'file';
    } catch (e) {
      throw new Error('Failed to parse gcal-creds.json: ' + (e && e.message ? e.message : String(e)));
    }
  }

  // Debug: report presence (NO secret contents)
  try {
    console.log('DEBUG getJwtAuth: source=' + (source || 'unknown') + ' client_email_present=' + !!creds.client_email + ' private_key_len=' + (creds.private_key ? String(creds.private_key).length : 0));
  } catch (e) {
    console.warn('DEBUG getJwtAuth: failed to log creds metadata:', e && e.message ? e.message : e);
  }

  const scopes = ['https://www.googleapis.com/auth/calendar'];
  const subject = impersonateUser || process.env.GOOGLE_IMPERSONATE_USER;

  console.log('DEBUG jwt prepared: client_email=', creds.client_email, ' subject=', subject, ' scopes=', scopes);
  const jwt = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    scopes,
    subject // Set the subject for impersonation
  );

  // ensure jwt.key and jwt.keyFile are set from creds.private_key (safe: no secret echoed)
  try { if (!jwt.key && creds && creds.private_key) jwt.key = creds.private_key; } catch (e) { }
  try { if (!jwt.keyFile && creds && creds.private_key) { fs.writeFileSync('/tmp/gcal_key.pem', creds.private_key, { mode: 0o600 }); jwt.keyFile = '/tmp/gcal_key.pem'; } } catch (e) { }

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

// Function to list events
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

module.exports = {
  getJwtAuth,
  mergeBusyIntervals,
  listEvents,
  // other exported methods
};