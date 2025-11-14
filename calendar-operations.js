/**
 * Calendar Operations - Enhanced scheduling rules
 *
 * - Enforces clinic default hours (Mon-Fri 08:00-18:00 ET)
 * - Allows per-provider overrides (e.g., weekend availability)
 * - Generates candidate start times aligned to 30-minute marks (hh:00, hh:30)
 * - Only offers starts that have at least `requiredFreeMinutes` free (default 60)
 * - Returns slots both in clinic/Eastern timezone (for booking) and in user's timezone (for display)
 * - Includes helpers to convert a user's chosen local time to an Eastern-time ISO range to pass to /book
 *
 * Dependencies:
 * - luxon (DateTime, Interval)
 * - googleapis calendar client (the `calendar` param used below)
 *
 * NOTE: Add provider-specific overrides to PROVIDER_SCHEDULES (keyed by calendarId).
 */

const { DateTime, Interval } = require('luxon');

const DEFAULT_TIMEZONE = 'America/New_York'; // Eastern time for clinic booking
const SLOT_ALIGNMENT_MINUTES = 30;           // only hh:00 and hh:30 starts
const DEFAULT_REQUIRED_FREE_MINUTES = 60;    // ensure at least 60 minutes free (55 appointment + 5 pad)
const MIN_BOOKED_MINUTES = 30;               // 25 appointment + 5 pad => 30 booked minutes
const MAX_BOOKED_MINUTES = 60;               // 55 appointment + 5 pad => 60 booked minutes

// Per-provider scheduling overrides. Replace placeholder IDs with actual calendar IDs.
const PROVIDER_SCHEDULES = {
    // 'provider_calendar_id@group.calendar.google.com': { allowWeekends: true, start_hour: 8, end_hour: 16, timezone: 'America/New_York' }
};

/**
 * Return scheduling rules for a calendarId (merge defaults with any provider overrides)
 */
function getCalendarRules(calendarId) {
    const override = PROVIDER_SCHEDULES[calendarId] || {};
    return {
        timezone: override.timezone || DEFAULT_TIMEZONE,
        allowWeekends: typeof override.allowWeekends === 'boolean' ? override.allowWeekends : false,
        start_hour: typeof override.start_hour === 'number' ? override.start_hour : 8,
        end_hour: typeof override.end_hour === 'number' ? override.end_hour : 18
    };
}

/**
 * Fetch busy times for a date range (returns array of {start, end} ISO strings)
 */
async function fetchBusyTimes(calendar, calendarId, startDateISO, endDateISO, timezone = DEFAULT_TIMEZONE) {
    const startDT = DateTime.fromISO(startDateISO, { zone: timezone }).startOf('day');
    const endDT = DateTime.fromISO(endDateISO, { zone: timezone }).endOf('day');

    const response = await calendar.freebusy.query({
        requestBody: {
            timeMin: startDT.toUTC().toISO(),
            timeMax: endDT.toUTC().toISO(),
            items: [{ id: calendarId }]
        }
    });

    return response?.data?.calendars?.[calendarId]?.busy || [];
}

/**
 * Helper: convert busy ranges (ISO strings) into Interval objects in the given timezone
 */
function busyRangesToIntervals(busyRanges, timezone) {
    return busyRanges.map(busy => {
        const s = DateTime.fromISO(busy.start).setZone(timezone);
        const e = DateTime.fromISO(busy.end).setZone(timezone);
        return Interval.fromDateTimes(s, e);
    });
}

/**
 * Generates candidate start DateTime objects for a day aligned to 30-minute boundaries.
 */
function generateCandidateStartsForDay(checkDate, rules, requiredFreeMinutes = DEFAULT_REQUIRED_FREE_MINUTES) {
    const { start_hour, end_hour } = rules;
    const timezone = rules.timezone || DEFAULT_TIMEZONE;

    const windowStart = checkDate.set({ hour: start_hour, minute: 0, second: 0, millisecond: 0 }).setZone(timezone);
    const windowEnd = checkDate.set({ hour: end_hour, minute: 0, second: 0, millisecond: 0 }).setZone(timezone);

    const candidates = [];
    let cursor = windowStart;
    const remainder = cursor.minute % SLOT_ALIGNMENT_MINUTES;
    if (remainder !== 0) {
        cursor = cursor.plus({ minutes: SLOT_ALIGNMENT_MINUTES - remainder }).startOf('minute');
    }

    while (cursor.plus({ minutes: requiredFreeMinutes }) <= windowEnd) {
        candidates.push(cursor);
        cursor = cursor.plus({ minutes: SLOT_ALIGNMENT_MINUTES });
    }

    return candidates;
}

/**
 * Check whether a candidate start (DateTime in calendar timezone) is available given busy intervals
 */
function isCandidateAvailable(candidateStart, requiredFreeMinutes, busyIntervals) {
    const candidateInterval = Interval.fromDateTimes(candidateStart, candidateStart.plus({ minutes: requiredFreeMinutes }));
    return !busyIntervals.some(bi => bi.overlaps(candidateInterval));
}

/**
 * Find available slots across multiple days (server-side)
 */
async function findAvailableSlotsMultiDay(calendar, calendarId, startDateISO, daysToCheck, opts = {}) {
    const {
        maxSlots = 4,
        requiredFreeMinutes = DEFAULT_REQUIRED_FREE_MINUTES,
        userTimezone = null
    } = opts;

    const rules = getCalendarRules(calendarId);
    const calendarTz = rules.timezone || DEFAULT_TIMEZONE;

    const allSlots = [];
    const startDate = DateTime.fromISO(startDateISO, { zone: calendarTz }).startOf('day');
    const now = DateTime.now().setZone(calendarTz);

    for (let dayOffset = 0; dayOffset < daysToCheck && allSlots.length < maxSlots; dayOffset++) {
        const checkDate = startDate.plus({ days: dayOffset });
        const weekday = checkDate.weekday; // 1 = Mon ... 7 = Sun
        if (!rules.allowWeekends && (weekday === 6 || weekday === 7)) continue;

        const dayStartISO = checkDate.toISODate();
        const busyRanges = await fetchBusyTimes(calendar, calendarId, dayStartISO, dayStartISO, calendarTz);
        const busyIntervals = busyRangesToIntervals(busyRanges, calendarTz);

        const candidates = generateCandidateStartsForDay(checkDate, rules, requiredFreeMinutes);

        let filteredCandidates = candidates;
        if (checkDate.hasSame(now, 'day')) {
            filteredCandidates = candidates.filter(c => c.plus({ minutes: requiredFreeMinutes }) > now);
        }

        for (const candidateStart of filteredCandidates) {
            if (allSlots.length >= maxSlots) break;
            const available = isCandidateAvailable(candidateStart, requiredFreeMinutes, busyIntervals);
            if (!available) continue;

            const startISOet = candidateStart.setZone(DEFAULT_TIMEZONE).toISO();
            const endISOet = candidateStart.plus({ minutes: requiredFreeMinutes }).setZone(DEFAULT_TIMEZONE).toISO();

            let startISOuser = null;
            let endISOuser = null;
            let display = `${candidateStart.toFormat('EEE MMM d')} at ${candidateStart.toFormat('h:mm a')} ET`;

            if (userTimezone) {
                const startUser = candidateStart.setZone(userTimezone);
                const endUser = candidateStart.plus({ minutes: requiredFreeMinutes }).setZone(userTimezone);
                startISOuser = startUser.toISO();
                endISOuser = endUser.toISO();
                display = `${startUser.toFormat('EEE MMM d')} at ${startUser.toFormat('h:mm a')} (${userTimezone}) — ${candidateStart.toFormat('h:mm a')} ET`;
            }

            allSlots.push({
                date: candidateStart.toISODate(),
                start_iso_et: startISOet,
                end_iso_et: endISOet,
                start_iso_user: startISOuser,
                end_iso_user: endISOuser,
                display
            });
        }
    }

    return allSlots;
}

/**
 * Convert a user's chosen local start ISO and bookedMinutes to an Eastern-time booking range.
 */
function convertUserSelectionToEastern(userStartIso, userTimezone = null, bookedMinutes = MAX_BOOKED_MINUTES) {
    let startDT;
    if (userTimezone && !userStartIso.endsWith('Z') && !userStartIso.includes('+') && !userStartIso.includes('-')) {
        startDT = DateTime.fromISO(userStartIso, { zone: userTimezone });
    } else {
        startDT = DateTime.fromISO(userStartIso).setZone(userTimezone || DEFAULT_TIMEZONE);
    }

    const endDTUser = startDT.plus({ minutes: bookedMinutes });
    const startET = startDT.setZone(DEFAULT_TIMEZONE);
    const endET = endDTUser.setZone(DEFAULT_TIMEZONE);

    return {
        start_iso_et: startET.toISO(),
        end_iso_et: endET.toISO()
    };
}

/**
 * Convenience: create Human-friendly display label for a slot
 */
function formatSlotLabel(slot) {
    if (slot.start_iso_user && slot.start_iso_et) {
        const startUser = DateTime.fromISO(slot.start_iso_user);
        const startET = DateTime.fromISO(slot.start_iso_et).setZone(DEFAULT_TIMEZONE);
        return `${startUser.toFormat('EEE MMM d @ h:mm a')} (${startUser.zoneName}) / ${startET.toFormat('h:mm a')} ET`;
    }
    if (slot.start_iso_et) {
        const s = DateTime.fromISO(slot.start_iso_et).setZone(DEFAULT_TIMEZONE);
        return `${s.toFormat('EEE MMM d @ h:mm a')} ET`;
    }
    return slot.display || 'Unavailable';
}

module.exports = {
    DEFAULT_TIMEZONE,
    SLOT_ALIGNMENT_MINUTES,
    DEFAULT_REQUIRED_FREE_MINUTES,
    MIN_BOOKED_MINUTES,
    MAX_BOOKED_MINUTES,
    PROVIDER_SCHEDULES,
    getCalendarRules,
    fetchBusyTimes,
    findAvailableSlotsMultiDay,
    convertUserSelectionToEastern,
    formatSlotLabel
};