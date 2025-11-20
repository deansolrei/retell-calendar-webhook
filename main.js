/**
 * main.js - Simplified launcher for the calendar API with robust fallback /availability
 *
 * Behavior:
 * - Attempts to load and start GoogleCalendarWebhook.js (your primary app).
 * - If the main app fails to load, starts a fallback server that exposes:
 *     - GET /        (health)
 *     - POST /availability  (robust normalizing handler for Retell calls)
 *     - POST /book         (simple fallback response)
 *     - POST /parse-name   (name parser for Retell Custom Function)
 *
 * The /availability handler normalizes inputs:
 * - Accepts nested requested_window object OR a JSON string OR flat form fields:
 *     requested_window_start_hour, requested_window_end_hour, requested_window_slot_duration_minutes
 * - Accepts calendar_id as either provider_token (preferred) or provider_calendar_id (email)
 * - Validates required fields and logs a normalized payload for debugging
 *
 * NOTE: Replace the PROVIDERS map with your canonical providers.js import when ready.
 */

const express = require('express');
const PROVIDERS = require('./providers.json');

// findProvider can remain the same, using PROVIDERS map

async function startMainApp() {
  try {
    const mainApp = require('./GoogleCalendarWebhook.js');
    // --- Paste this immediately after:
    // const mainApp = require('./GoogleCalendarWebhook.js');
    // and BEFORE mainApp.listen(...)

    // If mainApp is an Express app, attach a lightweight /parse-name POST handler
    try {
      if (mainApp && typeof mainApp.post === 'function') {
        // Ensure JSON body parsing is available (harmless if already set)
        try { mainApp.use(require('express').json()); } catch (e) { }

        mainApp.post('/parse-name', (req, res) => {
          // Accept either { user_message: "..." } or Retell-style { args: { user_message: "..."} }
          const maybeArgs = req.body && req.body.args ? req.body.args : null;
          const user_message = (req.body && (req.body.user_message || req.body.text)) ||
            (maybeArgs && maybeArgs.user_message) ||
            '';

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

          return res.status(200).json(splitName(user_message));
        });
      }
    } catch (attachErr) {
      console.warn('Could not attach /parse-name to mainApp:', attachErr && attachErr.message ? attachErr.message : attachErr);
    }

    if (mainApp && typeof mainApp.listen === 'function') {
      const PORT = process.env.PORT || 8080;

      mainApp.listen(PORT, '0.0.0.0', () => {
        console.log(`✅ Calendar API Server running on port ${PORT}`);
        console.log(`📅 Timezone: ${process.env.DEFAULT_TIMEZONE || 'America/New_York'}`);
        console.log(`🔐 Auth: ${process.env.SECRET_TOKEN ? 'Enabled' : 'DISABLED (Warning!)'}`);
      });

      return true;
    }

    return false;
  } catch (error) {
    console.error('Failed to load GoogleCalendarWebhook.js:', error && error.message ? error.message : error);
    return false;
  }
}

async function startFallbackServer() {
  console.log('Starting fallback server with normalized /availability handler...');

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Replace this map with an import from your providers.js when available.
  // Keys are provider tokens (lowercase). Values include provider token and calendar email.
  const PROVIDERS = {
    'katherine-robins': { token: 'katherine-robins', calendar_id: 'katherine-robins@solreibehavioralhealth.com' },
    'jodene-jensen': { token: 'jodene-jensen', calendar_id: 'jodene-jensen@solreibehavioralhealth.com' },
    'megan-ramirez': { token: 'megan-ramirez', calendar_id: 'megan-ramirez@solreibehavioralhealth.com' }
  };

  function findProvider(tokenOrEmail) {
    if (!tokenOrEmail) return null;
    const s = String(tokenOrEmail).toLowerCase();
    // direct token match
    if (PROVIDERS[s]) return PROVIDERS[s];
    // email match
    for (const k of Object.keys(PROVIDERS)) {
      if (PROVIDERS[k].calendar_id && PROVIDERS[k].calendar_id.toLowerCase() === s) {
        return PROVIDERS[k];
      }
    }
    return null;
  }

  function compactObject(obj) {
    const out = {};
    for (const k of Object.keys(obj || {})) {
      const v = obj[k];
      if (v !== undefined && v !== null && v !== '') out[k] = v;
    }
    return out;
  }

  // Health check
  app.get('/', (req, res) => {
    res.json({
      status: 'fallback',
      message: 'Calendar API fallback server is running',
      timestamp: new Date().toISOString()
    });
  });

  // NEW: simple name parser endpoint for Retell Custom Function
  // Accepts:
  //  - POST { "user_message": "Wayne Jones" }
  //  - or POST { "args": { "user_message": "Wayne Jones" } } (some Retell payloads)
  app.post('/parse-name', (req, res) => {
    try {
      // Extract user_message from common locations
      const maybeArgs = req.body && req.body.args ? req.body.args : null;
      const user_message = (req.body && (req.body.user_message || req.body.text)) ||
        (maybeArgs && maybeArgs.user_message) ||
        '';
      // Minimal splitter: first token = first_name, last token = last_name
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

      const parsed = splitName(user_message);
      // Always return top-level JSON object only
      return res.status(200).json(parsed);
    } catch (err) {
      console.error('Error in /parse-name:', err && err.stack ? err.stack : err);
      return res.status(200).json({ full_name: "", first_name: "", last_name: "" });
    }
  });

  // Robust /availability handler
  app.post('/availability', async (req, res) => {
    try {
      // Retell sends args inside req.body.args
      const args = (req.body && req.body.args) ? req.body.args : {};
      console.log('DEBUG RAW BODY:', JSON.stringify(req.body));

      // Normalize calendar identifier: accept token or email
      let calendarIdentifier = args.calendar_id || args.provider_token || args.provider_calendar_id || '';
      const provider = findProvider(calendarIdentifier);
      if (!provider) {
        console.warn('Unknown provider identifier:', calendarIdentifier);
        return res.status(400).json({
          error: 'invalid_provider',
          message: 'Unknown provider identifier'
        });
      }
      const provider_token = provider.token;
      const provider_calendar_id = provider.calendar_id;

      // Build requested_window object (accept object, stringified JSON, or flat fields)
      let requested_window = null;

      if (args.requested_window) {
        if (typeof args.requested_window === 'string') {
          try {
            requested_window = JSON.parse(args.requested_window);
          } catch (e) {
            requested_window = null;
          }
        } else if (typeof args.requested_window === 'object') {
          requested_window = args.requested_window;
        }
      }

      // Fallback: rebuild from flat form fields if necessary
      if (!requested_window) {
        const startHour = args.requested_window_start_hour !== undefined ? Number(args.requested_window_start_hour) : undefined;
        const endHour = args.requested_window_end_hour !== undefined ? Number(args.requested_window_end_hour) : undefined;
        const slotDur = args.requested_window_slot_duration_minutes !== undefined ? Number(args.requested_window_slot_duration_minutes) : undefined;

        requested_window = compactObject({
          start_hour: Number.isFinite(startHour) ? startHour : undefined,
          end_hour: Number.isFinite(endHour) ? endHour : undefined,
          slot_duration_minutes: Number.isFinite(slotDur) ? slotDur : undefined
        });
      }

      // Validate slot_duration_minutes (primary)
      const slot_duration_minutes = (args.slot_duration_minutes !== undefined) ? Number(args.slot_duration_minutes) : undefined;
      if (!Number.isFinite(slot_duration_minutes)) {
        return res.status(400).json({ error: 'invalid_request', message: 'slot_duration_minutes is required and must be a number' });
      }

      // Validate requested_date (must be YYYY-MM-DD)
      const requested_date = args.requested_date || '';
      if (!requested_date || !/^\d{4}-\d{2}-\d{2}$/.test(requested_date)) {
        return res.status(400).json({ error: 'invalid_request', message: 'requested_date is required and must be YYYY-MM-DD' });
      }

      // Build normalized args for downstream logic
      const normalized = {
        calendar_id: provider_token,               // use token for internal logic
        provider_calendar_id: provider_calendar_id,
        requested_date: requested_date,
        requested_window: requested_window || {},
        slot_duration_minutes: slot_duration_minutes,
        user_timezone: args.user_timezone || args.user_tz || (process.env.DEFAULT_TIMEZONE || 'UTC'),
        clinic_timezone: args.clinic_timezone || (process.env.CLINIC_TIMEZONE || process.env.DEFAULT_TIMEZONE || 'UTC'),
        clinic_hours_start: args.clinic_hours_start || '08:00',
        clinic_hours_end: args.clinic_hours_end || '18:00',
        days_to_check: Number.isFinite(Number(args.days_to_check)) ? Number(args.days_to_check) : 7,
        max_slots: Number.isFinite(Number(args.max_slots)) ? Number(args.max_slots) : 4
      };

      // Debug log the normalized payload
      console.log('DEBUG /availability parsed args:', JSON.stringify(normalized));

      // TODO: Replace this sampleResponse block with your real availability logic.
      // Use `normalized` as the canonical inputs for calendar lookups.
      const sampleResponse = {
        provider_token: normalized.calendar_id,
        provider_calendar_id: normalized.provider_calendar_id,
        date: normalized.requested_date,
        slots: [] // Populate with real slots: [{ start_iso, end_iso }, ...]
      };

      return res.status(200).json(sampleResponse);

    } catch (err) {
      console.error('Error in /availability:', err && err.stack ? err.stack : err);
      return res.status(500).json({ error: 'server_error', message: 'Internal error' });
    }
  });

  // Fallback /book endpoint
  app.post('/book', (req, res) => {
    console.log('Fallback /book called - main app not loaded properly');
    res.status(503).json({
      error: 'Service temporarily unavailable',
      message: 'The main calendar service failed to load. Please check GoogleCalendarWebhook.js',
      fallback: true
    });
  });

  const PORT = process.env.PORT || 8080;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`⚠️  Fallback server running on port ${PORT}`);
    console.log('⚠️  Main GoogleCalendarWebhook.js failed to load');
    console.log('⚠️  Calendar functionality is limited (use normalized /availability to test)');
  });
}

// Main execution
(async () => {
  const success = await startMainApp();

  if (!success) {
    await startFallbackServer();
  }
})();