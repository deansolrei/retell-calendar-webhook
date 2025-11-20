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

const providers = require('./providers'); // your provider directory helper
const calendarOps = require('./calendar-operations');

const router = express.Router();

// capture raw body while still parsing JSON (helpful for signature verify if needed)
router.use(express.json({
  limit: '256kb',
  verify: (req, res, buf) => {
    try { req.rawBody = buf && buf.length ? buf.toString('utf8') : ''; } catch (e) { req.rawBody = ''; }
  }
}));

// Config envs and defaults
const SECRET_TOKEN = process.env.SECRET_TOKEN || '';
const GOOGLE_CREDS_ENV = process.env.GOOGLE_CREDS || process.env.GCAL_KEY_JSON || null;
const GOOGLE_IMPERSONATE_USER = process.env.GOOGLE_IMPERSONATE_USER || process.env.GCAL_SUBJECT || null;
const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || calendarOps?.DEFAULT_TIMEZONE || 'America/New_York';
const DEFAULT_DAYS_TO_CHECK = Number(process.env.DAYS_TO_CHECK_AHEAD || 7);
const DEFAULT_REQUIRED_FREE_MINUTES = Number(process.env.DEFAULT_REQUIRED_FREE_MINUTES || calendarOps?.DEFAULT_REQUIRED_FREE_MINUTES || 30);

// Helper: validate incoming bearer token
function checkAuthBearer(req) {
  const auth = req.headers && (req.headers.authorization || req.headers.Authorization) || '';
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

// Initialize Google Calendar client (JWT with optional impersonation)
async function getCalendarClient() {
  if (getCalendarClient._cached) return getCalendarClient._cached;

  if (!GOOGLE_CREDS_ENV) {
    throw new Error('Missing service account credentials (set GOOGLE_CREDS or GCAL_KEY_JSON env)');
  }

  let creds;
  if (typeof GOOGLE_CREDS_ENV === 'string') {
    try {
      creds = JSON.parse(GOOGLE_CREDS_ENV);
    } catch (e) {
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

/**
 * POST /provider_lookup
 * Accepts payload either as raw body {state, insurance, zipcode?} or Retell-wrapped { name, call, args: {...} }
 */
router.post('/provider_lookup', async (req, res) => {
  try {
    if (!requireAuth(req, res)) return;

    // Accept either wrapped (req.body.args) or raw body
    const body = (req.body && req.body.args) ? req.body.args : (req.body || {});
    const state = (body.state || '').toString().trim().toUpperCase() || null;
    const insurance = (body.insurance || '').toString().trim() || null;
    const zipcode = (body.zipcode || body.postal_code || '') || '';

    if (!state || !insurance) {
      return res.status(400).json({ error: 'invalid_request', message: 'state and insurance are required' });
    }

    // providers.findProviders should accept { state, insurance, zipcode } and return matches
    const matches = providers.findProviders ? providers.findProviders({ state, insurance, zipcode }) : [];

    if (!matches || matches.length === 0) {
      return res.json({ providers: [] });
    }

    const first = matches[0];
    return res.json({
      token: first.token,
      display_name: first.display_name || first.name || '',
      calendar_id: first.calendar_id || ''
    });
  } catch (err) {
    console.error('provider_lookup error', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'server_error', message: 'provider lookup failed' });
  }
});

/**
 * POST /availability
 * Accepts normalized request as either req.body or req.body.args
 * Body shape expected: { calendar_id, requested_date (YYYY-MM-DD), slot_duration_minutes, days_to_check, user_timezone, requested_window, max_slots }
 */
router.post('/availability', async (req, res) => {
  try {
    if (!requireAuth(req, res)) return;

    const raw = req.body || {};
    const args = raw.args ? raw.args : raw;

    // Resolve provider token or calendar id
    const providerLookupId = args.calendar_id || args.calendarId || args.provider_token || args.providerToken || '';
    const provider = providers.getProvider ? providers.getProvider(providerLookupId) : null;
    if (!provider) {
      return res.status(400).json({ error: 'invalid_provider', message: 'Unknown provider identifier' });
    }
    const calendarIdToUse = provider.calendar_id;

    // requested_date or default
    const requested_date = args.requested_date || args.date || DateTime.now().setZone(DEFAULT_TIMEZONE).toISODate();
    if (!requested_date || !/^\d{4}-\d{2}-\d{2}$/.test(requested_date)) {
      return res.status(400).json({ error: 'invalid_request', message: 'requested_date is required and must be YYYY-MM-DD' });
    }

    const slot_duration_minutes = Number(args.slot_duration_minutes || args.slotDurationMinutes || args.requested_window?.slot_duration_minutes);
    if (!Number.isFinite(slot_duration_minutes)) {
      return res.status(400).json({ error: 'invalid_request', message: 'slot_duration_minutes is required and must be a number' });
    }

    const daysToCheck = Number.isFinite(Number(args.days_to_check || args.daysToCheck)) ? Number(args.days_to_check || args.daysToCheck) : DEFAULT_DAYS_TO_CHECK;
    const userTimezone = args.user_timezone || args.userTimezone || args.user_tz || DEFAULT_TIMEZONE;
    const requiredFreeMinutes = Number(args.required_free_minutes || args.requiredFreeMinutes || DEFAULT_REQUIRED_FREE_MINUTES);
    const maxSlots = Number.isFinite(Number(args.max_slots || args.maxSlots)) ? Number(args.max_slots || args.maxSlots) : 4;

    // Normalize requestedWindow: accept object or JSON string or flat fields
    let requestedWindow = args.requested_window || args.requestedWindow || null;
    if (typeof requestedWindow === 'string') {
      try { requestedWindow = JSON.parse(requestedWindow); } catch (e) { requestedWindow = null; }
    }
    if (!requestedWindow) {
      const startHour = args.requested_window_start_hour !== undefined ? Number(args.requested_window_start_hour) : undefined;
      const endHour = args.requested_window_end_hour !== undefined ? Number(args.requested_window_end_hour) : undefined;
      const slotDur = args.requested_window_slot_duration_minutes !== undefined ? Number(args.requested_window_slot_duration_minutes) : undefined;
      requestedWindow = {};
      if (Number.isFinite(startHour)) requestedWindow.start_hour = startHour;
      if (Number.isFinite(endHour)) requestedWindow.end_hour = endHour;
      if (Number.isFinite(slotDur)) requestedWindow.slot_duration_minutes = slotDur;
    }

    const calendar = await getCalendarClient();

    // Call into calendarOps; this function must return array of slots: { start_iso_et, end_iso_et, ... }
    const slots = await calendarOps.findAvailableSlotsMultiDay(
      calendar,
      calendarIdToUse,
      requested_date,
      daysToCheck,
      {
        maxSlots,
        requiredFreeMinutes,
        userTimezone,
        requestedWindow,
        slotDurationMinutes: slot_duration_minutes
      }
    );

    const response = {
      provider_token: provider.token,
      provider_name: provider.display_name || provider.name || '',
      available_slots: slots
    };

    // Add backward-compatible slotN fields (slot1..slot8)
    for (let i = 0; i < Math.min(8, slots.length); i++) {
      const s = slots[i];
      const n = i + 1;
      response[`slot${n}_start_iso`] = s.start_iso_et || s.start_iso || null;
      response[`slot${n}_end_iso`] = s.end_iso_et || s.end_iso || null;
      response[`slot${n}_label`] = (typeof calendarOps.formatSlotLabel === 'function') ? calendarOps.formatSlotLabel(s) : (s.display || '');
    }

    return res.json(response);
  } catch (err) {
    console.error('Error in /availability:', err && (err.stack || err.message) ? (err.stack || err.message) : err);
    return res.status(500).json({ error: 'server_error', message: 'Failed to fetch availability' });
  }
});

/**
 * POST /book
 * Body accepted: { calendar_id, start, end, attendee_name, attendee_email, user_start_iso, booked_minutes, confirm_booking, send_confirmation, description }
 */
router.post('/book', async (req, res) => {
  try {
    if (!requireAuth(req, res)) return;

    const raw = req.body || {};
    const body = raw.args ? raw.args : raw;

    const providerLookupId = body.calendar_id || body.calendarId || body.provider_token || body.providerToken || '';
    const provider = providers.getProvider ? providers.getProvider(providerLookupId) : null;
    if (!provider) {
      return res.status(400).json({ error: 'invalid_provider', message: 'Unknown provider identifier' });
    }
    const calendarIdToUse = provider.calendar_id;

    // require confirm_booking true as a safety guard
    if (body.confirm_booking !== true) {
      return res.status(400).json({ error: 'missing_confirmation', message: 'Booking requires confirm_booking=true' });
    }

    let startIso = body.start || body.start_iso || null;
    let endIso = body.end || body.end_iso || null;

    // If user provided user_start_iso and booked_minutes, convert via calendarOps helper
    if ((!startIso || !endIso) && body.user_start_iso) {
      const bookedMinutes = Number(body.booked_minutes || body.bookedMinutes || calendarOps.MAX_BOOKED_MINUTES || 30);
      const conv = calendarOps.convertUserSelectionToEastern
        ? calendarOps.convertUserSelectionToEastern(body.user_start_iso, body.user_timezone || body.userTimezone || null, bookedMinutes)
        : null;
      if (conv) {
        startIso = conv.start_iso_et;
        endIso = conv.end_iso_et;
      }
    }

    if (!startIso || !endIso) {
      return res.status(400).json({ error: 'invalid_request', message: 'Provide start+end or user_start_iso+booked_minutes' });
    }

    // Validate ISO
    const dtStart = DateTime.fromISO(startIso);
    const dtEnd = DateTime.fromISO(endIso);
    if (!dtStart.isValid || !dtEnd.isValid) {
      return res.status(400).json({ error: 'invalid_request', message: 'Invalid start or end ISO format' });
    }

    const calendar = await getCalendarClient();

    // Best-effort slot free check
    let slotFree = true;
    if (typeof calendarOps.isSlotFree === 'function') {
      try {
        slotFree = await calendarOps.isSlotFree(calendar, calendarIdToUse, startIso, endIso);
      } catch (e) {
        console.warn('isSlotFree check failed; proceeding', e && e.message ? e.message : e);
        slotFree = true;
      }
    }

    if (!slotFree) {
      return res.status(409).json({ error: 'slot_unavailable', message: 'Requested slot is no longer available' });
    }

    const attendeeName = body.attendee_name || body.attendeeName || body.name || null;
    const attendeeEmail = body.attendee_email || body.attendeeEmail || body.email || null;
    const sendConfirmation = Boolean(body.send_confirmation || body.sendConfirmation || false);

    const event = {
      summary: `Appointment${attendeeName ? ' with ' + attendeeName : ''}`,
      description: (body.description || '').toString().slice(0, 2000),
      start: { dateTime: startIso },
      end: { dateTime: endIso }
    };

    if (attendeeEmail) {
      event.attendees = [{ email: attendeeEmail }];
    }

    const insertParams = {
      calendarId: calendarIdToUse,
      requestBody: event
    };

    if (sendConfirmation) insertParams.sendUpdates = 'all';

    const insertRes = await calendar.events.insert(insertParams);
    const created = insertRes?.data || {};

    return res.json({
      success: true,
      provider_token: provider.token,
      provider_name: provider.display_name || provider.name || '',
      event_id: created.id || null,
      event_link: created.htmlLink || null,
      summary: created.summary || event.summary,
      start: startIso,
      end: endIso,
      confirmation_sent: !!sendConfirmation
    });
  } catch (err) {
    console.error('Error in /book:', err && (err.response?.data || err.message) ? (err.response?.data || err.message) : err);
    const message = err?.response?.data || err?.message || String(err);
    if (typeof message === 'string' && message.includes('Service accounts cannot invite attendees')) {
      return res.status(400).json({ error: 'service_account_invite_restriction', message: 'Service accounts cannot invite attendees without Domain-Wide Delegation.' });
    }
    return res.status(500).json({ error: 'Failed to book appointment', details: message });
  }
});

// Health endpoint
router.get('/health', (_req, res) => res.json({ ok: true, timestamp: new Date().toISOString() }));

module.exports = router;

// If run directly, mount router to a new app and listen
if (require.main === module) {
  const app = express();
  const PORT = Number(process.env.PORT || 8080);

  app.use(express.json({ limit: '256kb' }));
  app.use('/', router);

  app.listen(PORT, () => {
    console.log(`GoogleCalendarWebhook (router) listening on port ${PORT}`);
  });
}