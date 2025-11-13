// Defensive calendar utilities (commonjs) - place this file at project root as cal_util.js
// Usage:
//   const { safeToISOString, getCalEventAvailability } = require('./cal_util');
//   const slots = getCalEventAvailability(eventsArray);

const { DateTime } = require('luxon');

/**
 * safeToISOString(value)
 * Accepts:
 *  - JS Date
 *  - ISO string (datetime or date-only)
 *  - Luxon DateTime
 *  - numeric milliseconds timestamp
 * Returns ISO string (or null if invalid)
 */
function safeToISOString(value) {
    try {
        if (value === undefined || value === null) return null;

        // Luxon DateTime
        if (typeof value === 'object' && value && typeof value.isValid === 'boolean') {
            if (!value.isValid) return null;
            return value.toISO();
        }

        // JS Date
        if (value instanceof Date) {
            if (isNaN(value.getTime())) return null;
            return value.toISOString();
        }

        // number (milliseconds)
        if (typeof value === 'number') {
            const d = new Date(value);
            if (isNaN(d.getTime())) return null;
            return d.toISOString();
        }

        // string
        if (typeof value === 'string') {
            const s = value.trim();
            if (!s) return null;

            // date-only (YYYY-MM-DD): return start-of-day in UTC
            const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
            if (dateOnly.test(s)) {
                const dt = DateTime.fromISO(s, { zone: 'utc' }).startOf('day');
                if (!dt.isValid) return null;
                return dt.toISO();
            }

            // try native parser
            const parsed = new Date(s);
            if (!isNaN(parsed.getTime())) return parsed.toISOString();

            // Luxon fallback
            const dt = DateTime.fromISO(s);
            if (dt.isValid) return dt.toISO();

            return null;
        }

        return null;
    } catch (err) {
        return null;
    }
}

/**
 * getCalEventAvailability(events)
 * - Given array of Google Calendar events (event objects),
 *   returns array of normalized slots:
 *   [{ id, title, start_iso, end_iso }, ...]
 * - Skips events with missing/invalid start or end; logs them for debugging.
 */
function getCalEventAvailability(events = []) {
    const slots = [];
    if (!Array.isArray(events)) return slots;

    for (const ev of events) {
        try {
            // Google events: ev.start.dateTime or ev.start.date (all-day). Accept either
            const startRaw = ev && ev.start && (ev.start.dateTime || ev.start.date) ? (ev.start.dateTime || ev.start.date) : ev && ev.start ? ev.start : undefined;
            const endRaw = ev && ev.end && (ev.end.dateTime || ev.end.date) ? (ev.end.dateTime || ev.end.date) : ev && ev.end ? ev.end : undefined;

            const start_iso = safeToISOString(startRaw);
            const end_iso = safeToISOString(endRaw);

            if (!start_iso || !end_iso) {
                console.warn('Skipping event with invalid start/end', { id: ev && ev.id, summary: ev && ev.summary, startRaw, endRaw });
                continue;
            }

            const startTs = Date.parse(start_iso);
            const endTs = Date.parse(end_iso);
            if (isNaN(startTs) || isNaN(endTs) || startTs >= endTs) {
                console.warn('Skipping event with invalid ordering', { id: ev && ev.id, start_iso, end_iso });
                continue;
            }

            slots.push({
                id: ev && ev.id,
                title: ev && ev.summary || '',
                start_iso,
                end_iso
            });
        } catch (err) {
            console.error('Error parsing event (skipping)', { id: ev && ev.id, err: err && err.message });
            continue;
        }
    }

    return slots;
}

module.exports = {
    safeToISOString,
    getCalEventAvailability
};