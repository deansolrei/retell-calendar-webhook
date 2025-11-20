/**
 * main.js - Launcher that mounts the router-based GoogleCalendarWebhook (or falls back)
 *
 * Updated to mount an exported router from GoogleCalendarWebhook.js when present.
 * If GoogleCalendarWebhook exports an app instance instead, it will still work.
 *
 * Keeps the fallback /availability server if loading the main module fails.
 */

const express = require('express');

let PROVIDERS = {};
try {
  PROVIDERS = require('./providers.json');
  console.log('Loaded providers.json');
} catch (e) {
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
  if (PROVIDERS[s]) return PROVIDERS[s];
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

// Attach parse helpers (do NOT re-register express.json() here)
function attachParseName(appInstance) {
  if (!appInstance || typeof appInstance.post !== 'function') return;
  try {
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
    appInstance.post('/parse-provider', (req, res) => {
      try {
        const maybeArgs = req.body && req.body.args ? req.body.args : null;
        const raw = (req.body && (req.body.user_message || req.body.text)) ||
          (maybeArgs && maybeArgs.user_message) ||
          '';
        const s = String(raw).trim().toLowerCase();

        const negatives = ["don't have", "dont have", "i don't have", "i dont have", "no provider", "nope", "none", "no"];
        for (const p of negatives) {
          if (s.includes(p)) {
            return res.json({ provider_name: '', provider_token: '', provider_calendar_id: '' });
          }
        }

        for (const key of Object.keys(PROVIDERS)) {
          const p = PROVIDERS[key];
          const token = String(p.token || key).toLowerCase();
          const cal = String(p.calendar_id || '').toLowerCase();
          const name = String(p.name || '').toLowerCase();

          if (s === token || s === cal) {
            return res.json({ provider_name: p.name || token, provider_token: token, provider_calendar_id: p.calendar_id || '' });
          }

          if (s.includes(token)) {
            return res.json({ provider_name: p.name || token, provider_token: token, provider_calendar_id: p.calendar_id || '' });
          }
          if (name && s.includes(name)) {
            return res.json({ provider_name: p.name || token, provider_token: token, provider_calendar_id: p.calendar_id || '' });
          }

          const nameParts = name ? name.split(/\s+/).filter(Boolean) : [];
          for (const np of nameParts) {
            if (np && s.includes(np)) {
              return res.json({ provider_name: p.name || token, provider_token: token, provider_calendar_id: p.calendar_id || '' });
            }
          }

          if (cal) {
            const calLocal = cal.split('@')[0];
            if (calLocal && s.includes(calLocal)) {
              return res.json({ provider_name: p.name || token, provider_token: token, provider_calendar_id: p.calendar_id || '' });
            }
          }
        }

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

/**
 * Updated startMainApp: tries to require GoogleCalendarWebhook.js and handle both:
 * - it exports an express app (has listen), OR
 * - it exports an express.Router (has use)
 */
async function startMainApp() {
  try {
    const mainModule = require('./GoogleCalendarWebhook.js'); // may be app or router

    // If the module exported an express App instance (has listen)
    if (mainModule && typeof mainModule.listen === 'function') {
      // Attach helpers (assume mainModule has express.json() registered internally)
      attachParseName(mainModule);
      attachParseProvider(mainModule);

      const PORT = process.env.PORT || 8080;
      mainModule.listen(PORT, '0.0.0.0', () => {
        console.log(`✅ Calendar API Server running on port ${PORT}`);
        console.log(`📅 Timezone: ${process.env.DEFAULT_TIMEZONE || 'America/New_York'}`);
        console.log(`🔐 Auth: ${process.env.SECRET_TOKEN ? 'Enabled' : 'DISABLED (Warning!)'}`);
      });

      return true;
    }

    // Otherwise assume module exported an express.Router
    if (mainModule && typeof mainModule.use === 'function') {
      const app = express();
      // register body parser once at top-level
      app.use(express.json({ limit: '256kb' }));

      // attach parse helpers to top-level app
      attachParseName(app);
      attachParseProvider(app);

      // mount the router exported by GoogleCalendarWebhook.js
      app.use('/', mainModule);

      const PORT = process.env.PORT || 8080;
      app.listen(PORT, '0.0.0.0', () => {
        console.log(`✅ Calendar API Server (mounted router) running on port ${PORT}`);
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

  app.get('/', (req, res) => {
    res.json({
      status: 'fallback',
      message: 'Calendar API fallback server is running',
      timestamp: new Date().toISOString()
    });
  });

  app.post('/availability', async (req, res) => {
    try {
      const args = (req.body && req.body.args) ? req.body.args : {};
      console.log('DEBUG RAW BODY:', JSON.stringify(req.body));

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

      let requested_window = null;
      if (args.requested_window) {
        if (typeof args.requested_window === 'string') {
          try { requested_window = JSON.parse(args.requested_window); } catch (e) { requested_window = null; }
        } else if (typeof args.requested_window === 'object') {
          requested_window = args.requested_window;
        }
      }

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

      const slot_duration_minutes = (args.slot_duration_minutes !== undefined) ? Number(args.slot_duration_minutes) : undefined;
      if (!Number.isFinite(slot_duration_minutes)) {
        return res.status(400).json({ error: 'invalid_request', message: 'slot_duration_minutes is required and must be a number' });
      }

      const requested_date = args.requested_date || '';
      if (!requested_date || !/^\d{4}-\d{2}-\d{2}$/.test(requested_date)) {
        return res.status(400).json({ error: 'invalid_request', message: 'requested_date is required and must be YYYY-MM-DD' });
      }

      const normalized = {
        calendar_id: provider_token,
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

      console.log('DEBUG /availability parsed args:', JSON.stringify(normalized));

      const sampleResponse = {
        provider_token: normalized.calendar_id,
        provider_calendar_id: normalized.provider_calendar_id,
        date: normalized.requested_date,
        slots: []
      };

      return res.status(200).json(sampleResponse);
    } catch (err) {
      console.error('Error in /availability:', err && err.stack ? err.stack : err);
      return res.status(500).json({ error: 'server_error', message: 'Internal error' });
    }
  });

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

(async () => {
  const success = await startMainApp();
  if (!success) {
    await startFallbackServer();
  }
})();