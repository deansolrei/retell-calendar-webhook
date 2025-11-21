const ops = require('./calendar-operations');

(async () => {
  try {
    const fn = typeof ops.get_provider_availability === 'function'
      ? ops.get_provider_availability
      : typeof ops.get_calendar_slots === 'function'
        ? ops.get_calendar_slots
        : null;

    if (!fn) {
      console.error('NO_AVAIL_FN', Object.keys(ops));
      process.exit(2);
    }

    const res = await fn({ calendarId: 'primary', requestedDate: '2025-11-25', slotDurationMinutes: 30 });
    console.log('RESULT', JSON.stringify(res, null, 2));
    process.exit(0);
  } catch (e) {
    console.error('ERR_STACK', e && (e.stack || e.message || e));
    process.exit(1);
  }
})();
