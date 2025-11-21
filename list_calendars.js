const {google} = require('googleapis');
const key = JSON.parse(process.env.GOOGLE_CREDS || '{}');
(async () => {
  try {
    const auth = new google.auth.JWT(key.client_email, null, key.private_key, ['https://www.googleapis.com/auth/calendar.readonly']);
    await auth.authorize();
    const calendar = google.calendar({version: 'v3', auth});
    const res = await calendar.calendarList.list();
    console.log(JSON.stringify(res.data, null, 2));
  } catch (e) {
    console.error('ERR', e && (e.stack || e.message || e));
    process.exit(1);
  }
})();
