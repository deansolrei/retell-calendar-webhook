const express = require('express');
const router = express.Router();
const fs = require('fs');
const {google} = require('googleapis');

async function getJwtAuth() {
  // Read creds from env or file (non-secret here)
  const creds = process.env.GOOGLE_CREDS ? JSON.parse(process.env.GOOGLE_CREDS) : JSON.parse(fs.readFileSync('./gcal-creds.json', 'utf8'));
  const jwt = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/calendar.events']
  );
  await jwt.authorize();
  return jwt;
}

router.post('/book_provider_appointment', async (req, res) => {
  try {
    const { calendar_id, calendar_event } = req.body;
    if (!calendar_id || !calendar_event) {
      return res.status(400).json({ error: 'bad_request', message: 'calendar_id and calendar_event required' });
    }

    const auth = await getJwtAuth();
    const calendar = google.calendar({ version: 'v3', auth });

    const insertRes = await calendar.events.insert({
      calendarId: calendar_id,
      resource: calendar_event,
      sendUpdates: 'all' // change to 'none' if you do not want emails
    });

    return res.json({ ok: true, event: insertRes.data });
  } catch (err) {
    console.error('book_provider_appointment error:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server_error', message: err && err.message ? err.message : 'Failed to create event' });
  }
});

module.exports = router;