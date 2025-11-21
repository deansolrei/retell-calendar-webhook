// Lightweight test that calls the calendar-operations exported function used by the service.
// Adjust calendarId to a calendar the service account can access (or a calendar shared with it).
(async () => {
  try {
    const ops = require('./calendar-operations');
    // Many helper implementations expose findAvailableSlotsMultiDay; try that first.
    if (typeof ops.findAvailableSlotsMultiDay === 'function') {
      const res = await ops.findAvailableSlotsMultiDay('primary' /*calendarId*/, '2025-11-25' /*startDateISO*/, { daysToCheck: 1, slotDurationMinutes: 30 });
      console.log('RESULT:', JSON.stringify(res, null, 2));
      process.exit(0);
    }
    // fallback: if module exposes a different API, print its keys
    console.log('EXPORT_KEYS:', Object.keys(ops));
    process.exit(2);
  } catch (e) {
    console.error('ERR_STACK:', e && (e.stack || e.message || e));
    process.exit(1);
  }
})();