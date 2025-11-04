```markdown
# retell-calendar-webhook

Webhook service that integrates a Retell AI conversation agent with Google Calendar and is deployable to Cloud Run.

Purpose
- Receive webhook calls from Retell containing conversation variables (provider name, requested date/time, user info)
- Query provider calendar availability and present time slots
- Create calendar events when a user selects a slot

Repository layout (organized for clarity)
- src/                      — application source code (main.js, GoogleCalendarWebhook.js)
- config/                   — example environment variables (no secrets)
- docs/                     — conversation notes and knowledge base files
- Dockerfile                — container build (root)
- package.json / lock       — NPM metadata

Important: secrets and credentials
- Do NOT commit credentials.json, creds-base64.txt, or any private keys to the repo.
- Use Google Secret Manager, Cloud Run environment variables, or GitHub secrets.
- See config/example.env for the variable names expected by the app.

Quick local run (development)
1. Install dependencies:
   npm install

2. Provide credentials locally (one of these approaches):
   - Set the GOOGLE_CREDS environment variable to the JSON string of a Google service account key, or
   - Set GOOGLE_CREDS_BASE64 to the base64-encoded JSON key, or
   - Put credentials.json in the project root (FOR LOCAL TEST ONLY — do NOT commit).

3. Set SECRET_TOKEN to a shared secret used by Retell to authorize webhooks.

4. Start the app:
   npm start
   The server listens on port 8080 by default.

Endpoints
- GET /                     — health check
- POST /availability        — returns available time slots for the given date and calendar_id
- POST /book                — creates an event (requires date, start_time, end_time; see code for details)

Deploy to Cloud Run (example)
1. Build and push the container:
   gcloud builds submit --tag gcr.io/$(gcloud config get-value project)/retell-calendar-api

2. Deploy:
   gcloud run deploy retell-calendar-api \
     --image=gcr.io/$(gcloud config get-value project)/retell-calendar-api \
     --region=us-central1 --platform=managed \
     --update-env-vars SECRET_TOKEN=<your-secret>,GOOGLE_CREDS_BASE64=<base64-encoded-creds> \
     --allow-unauthenticated

Notes
- Use a service account with minimum required scopes (calendar).
- Consider storing the credentials in Secret Manager and referencing them via Cloud Run secrets.
- Test locally with ngrok or deploy to a private staging Cloud Run service for safe iteration.

If you want, I can:
- Prepare a small GitHub Actions workflow to build and push images automatically.
- Provide a step-by-step checklist (with exact clicks) to add these files using the GitHub web UI or VS Code.
```