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
 *     - POST /parse-provider (provider name -> token/calendar lookup)
 *
 * Notes:
 * - This file prefers a providers.json in repo root. If missing, it falls back to
 *   a small built-in providers map (with solreibehavioralhealth.com addresses).
 * - Both the primary mainApp (if it is an Express app) and the fallback server
 *   expose the same utility endpoints so Retell can call a single service URL.
 */

const express = require('express');
let PROVIDERS = {};
try {
  // prefer canonical external providers.json when present
  PROVIDERS = require('./providers.json');
  console.log('Loaded providers.json');
} catch (e) {
  // fallback static map (update these addresses if needed)
  PROVIDERS = {
    'katherine-robins': { token: 'katherine-robins', calendar_id: 'katherine-robins@solreibehavioralhealth.com', name: 'Katherine Robins' },
    'jodene-jensen': { token: 'jodene-jensen', calendar_id: 'jodene-jensen@solreibehavioralhealth.com', name: 'Jodene Jensen' },
    'megan-ramirez': { token: 'megan-ramirez', calendar_id: 'megan-ramirez@solreibehavioralhealth.com', name: 'Megan Ramirez' }
  };
  console.warn('providers.json not found — using built-in PROVIDERS fallback');
}

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

function attachParseName(appInstance) {
  if (!appInstance || typeof appInstance.post !== 'function') return;
  try {
    // Ensure JSON parsing
    try { appInstance.use(express.json()); } catch (e) { }
    appInstance.post('/parse-name', (req, res) => {
      try {
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
      } catch (err) {
        console.error('Error in /parse-name handler:', err && err.stack ? err.stack : err);
        return res.status(200).json({ full_name: "", first_name: "", last_name: "" });
      }
    });
  } catch (err) {
    console.warn('Could not attach /parse-name:', err && err.message ? err.message : err);
  }
}

function attachParseProvider(appInstance) {
  if (!appInstance || typeof appInstance.post !== 'function') return;
  try {
    try { appInstance.use(express.json()); } catch (e) { }
    appInstance.post('/parse-provider', (req, res) => {
      try {
        const maybeArgs = req.body && req.body.args ? req.body.args : null;
        const raw = (req.body && (req.body.user_message || req.body.text)) ||
          (maybeArgs && maybeArgs.user_message) ||
          '';
        const s = String(raw).trim().toLowerCase();

        // quick negatives -> empty token
        const negatives = ["don't have", "dont have", "i don't have", "i dont have", "no provider", "nope", "none", "no"];
        for (const p of negatives) {
          if (s.includes(p)) {
            return res.json({ provider_name: '', provider_token: '', provider_calendar_id: '' });
          }
        }

        // Build scan keys from PROVIDERS: token, name, first/last parts, calendar_id
        for (const key of Object.keys(PROVIDERS)) {
          const p = PROVIDERS[key];
          const token = String(p.token || key).toLowerCase();
          const cal = String(p.calendar_id || '').toLowerCase();
          const name = String(p.name || '').toLowerCase();

          // check token or calendar_id directly
          if (s === token || s === cal) {
            return res.json({ provider_name: p.name || token, provider_token: token, provider_calendar_id: p.calendar_id || '' });
          }

          // contains token, name, or parts
          if (s.includes(token)) {
            return res.json({ provider_name: p.name || token, provider_token: token, provider_calendar_id: p.calendar_id || '' });
          }
          if (name && s.includes(name)) {
            return res.json({ provider_name: p.name || token, provider_token: token, provider_calendar_id: p.calendar_id || '' });
          }
          // match on last name or first name token fragments
          const nameParts = name ? name.split(/\s+/).filter(Boolean) : [];
          for (const np of nameParts) {
            if (np && s.includes(np)) {
              return res.json({ provider_name: p.name || token, provider_token: token, provider_calendar_id: p.calendar_id || '' });
            }
          }
          // match on calendar local part (before @)
          if (cal) {
            const calLocal = cal.split('@')[0];
            if (calLocal && s.includes(calLocal)) {
              return res.json({ provider_name: p.name || token, provider_token: token, provider_calendar_id: p.calendar_id || '' });
            }
          }
        }

        // No match: return raw provider_name but empty token (trigger clarify)
        return res.json({ provider_name: raw || '', provider_token: '', provider_calendar_id: '' });
      } catch (err) {
        console.error('Error in /parse-provider handler:', err && err.stack ? err.stack : err);
        return res.status(200).json({ provider_name: '', provider_token: '', provider_calendar_id: '' });
      }
    });
  } catch (err) {
    console.warn('Could not attach /parse-provider:', err && err.message ? err.message : err);
  }
}

async function startMainApp() {
  try {
    const mainApp = require('./GoogleCalendarWebhook.js');

    // Attach helpers (if mainApp is an Express app)
    attachParseName(mainApp);
    attachParseProvider(mainApp);

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

  // attach parse-name and parse-provider to fallback app
  attachParseName(app);
  attachParseProvider(app);

  // Health check
  app.get('/', (req, res) => {
    res.json({
      status: 'fallback',
      message: 'Calendar API fallback server is running',
      timestamp: new Date().toISOString()
    });
  });

  // Robust /availability handler (uses PROVIDERS and findProvider)
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