'use strict';
const ops = require('./calendar-operations');
function pickFunction(...names){for(const n of names){if(typeof ops[n]==='function') return ops[n].bind(ops);}return null;}
const get_provider_availability = pickFunction('get_provider_availability','get_calendar_slots','findAvailableSlotsMultiDay','get_calendar_availability');
const get_calendar_slots = pickFunction('get_calendar_slots','get_provider_availability','findAvailableSlotsMultiDay');
const _book = pickFunction('book_provider_appointment','bookAppointment','create_event','insertEvent');
async function book_provider_appointment(payload){ if(_book) return _book(payload); return { ok:false, error:'not_implemented', message:'booking functionality not available' }; }
module.exports = {
  get_provider_availability: get_provider_availability || (async ()=>({ ok:false, error:'not_implemented', message:'availability not available' })),
  get_calendar_slots: get_calendar_slots || (async ()=>({ ok:false, error:'not_implemented', message:'calendar slots not available' })),
  book_provider_appointment,
  DEFAULT_TIMEZONE: ops.DEFAULT_TIMEZONE || 'America/New_York',
  DEFAULT_REQUIRED_FREE_MINUTES: ops.DEFAULT_REQUIRED_FREE_MINUTES || 60
};
