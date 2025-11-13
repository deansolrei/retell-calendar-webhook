// list_events.js
// Usage (one-off): GOOGLE_CREDS_JSON="$(gcloud secrets versions access latest --secret=retell-gcal-key --project=retell-ai-agent-calendar)" node list_events.js "<calendarId>"
// Example calendarId: c_fe9450004f174ae74615e904639bbb7a888c594509b87567041d5d726299e7a3@group.calendar.google.com

const { google } = require('googleapis');

async function main() {
    try {
        const raw = process.env.GOOGLE_CREDS_JSON;
        if (!raw) {
            console.error('ERROR: GOOGLE_CREDS_JSON environment variable not set.');
            console.error('Set it with: GOOGLE_CREDS_JSON="$(gcloud secrets versions access latest --secret=retell-gcal-key --project=retell-ai-agent-calendar)" node list_events.js "<calendarId>"');
            process.exitCode = 2;
            return;
        }

        const creds = JSON.parse(raw);
        const calendarId = process.argv[2];
        if (!calendarId) {
            console.error('Usage: node list_events.js "<calendarId>"');
            process.exitCode = 2;
            return;
        }

        const auth = new google.auth.JWT(
            creds.client_email,
            null,
            creds.private_key,
            ['https://www.googleapis.com/auth/calendar.readonly']
        );

        await auth.authorize();

        const calendar = google.calendar({ version: 'v3', auth });
        const now = new Date().toISOString();

        const res = await calendar.events.list({
            calendarId,
            timeMin: now,
            maxResults: 10,
            singleEvents: true,
            orderBy: 'startTime',
        });

        const items = res.data.items || [];
        console.log('Found', items.length, 'upcoming events:');
        items.forEach((e, i) => {
            const start = e.start?.dateTime || e.start?.date || 'unknown';
            console.log(`${i + 1}. ${e.summary || '(no summary)'} — ${start} (id: ${e.id})`);
        });

        if (items.length === 0) console.log('(no upcoming events returned)');
    } catch (err) {
        console.error('ERROR calling Calendar API:');
        console.error(err && err.message ? err.message : err);
        // Print more of the error object for debugging (redact sensitive fields if you paste it)
        console.error(err);
        process.exitCode = 1;
    }
}

main();