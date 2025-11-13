/**
 * GoogleCalendarWebhook.js - Fixed to handle Retell's date issues
 * 
 * Key changes:
 * - When a past date is detected, check TODAY instead of future year
 * - Option to check multiple days ahead when no specific date is intended
 */

const express = require('express');
const { google } = require('googleapis');
const { DateTime, Duration } = require('luxon');

const app = express();
app.use(express.json());

// Config
const PORT = process.env.PORT || 8080;
const SECRET_TOKEN = process.env.SECRET_TOKEN || '';
const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || 'America/New_York';
const SLOT_DURATION_MINUTES = Number(process.env.SLOT_DURATION_MINUTES) || 60;
const SLOT_ALIGNMENT_MINUTES = Number(process.env.SLOT_ALIGNMENT_MINUTES) || 15;
const DEFAULT_WORKDAY_START = Number(process.env.DEFAULT_WORKDAY_START || 9);
const DEFAULT_WORKDAY_END = Number(process.env.DEFAULT_WORKDAY_END || 17);
const DAYS_TO_CHECK_AHEAD = 7; // Check up to 7 days ahead for availability

// -------------------- Helper Utilities --------------------

/**
 * Check if a date string appears to be a Retell example/placeholder date
 */
function isRetellExampleDate(dateStr) {
  if (!dateStr) return false;

  // Known problematic dates from Retell examples
  const exampleDates = [
    '2024-05-15',
    '2024-05-17',
    '2004-', // Any 2004 date
  ];

  // Check if it matches any known example
  for (const example of exampleDates) {
    if (dateStr.startsWith(example)) {
      return true;
    }
  }

  // Check if date is more than 30 days in the past (likely an example)
  try {
    const date = DateTime.fromISO(dateStr);
    const now = DateTime.now();
    const daysDiff = now.diff(date, 'days').days;

    if (daysDiff > 30) {
      console.log(`Date ${dateStr} is ${Math.floor(daysDiff)} days in the past - treating as example date`);
      return true;
    }
  } catch (e) {
    // Ignore parse errors
  }

  return false;
}

/**
 * Smart date resolution - handles Retell's tendency to send old example dates
 */
function resolveIntendedDate(dateStr, timezone = DEFAULT_TIMEZONE) {
  const now = DateTime.now().setZone(timezone);

  // If no date or it's a Retell example, return today
  if (!dateStr || isRetellExampleDate(dateStr)) {
    console.log(`Detected example/placeholder date "${dateStr}" - using today instead`);
    return {
      date: now.toISODate(),
      wasExample: true,
      original: dateStr,
      checkMultipleDays: true // Signal to check multiple days
    };
  }

  // Try to parse the date
  let targetDate;
  try {
    targetDate = DateTime.fromISO(dateStr, { zone: timezone });
    if (!targetDate.isValid) {
      // Try parsing as YYYY-MM-DD
      targetDate = DateTime.fromFormat(dateStr, 'yyyy-MM-dd', { zone: timezone });
    }
  } catch (e) {
    console.log(`Could not parse date "${dateStr}" - using today`);
    return {
      date: now.toISODate(),
      wasExample: false,
      original: dateStr,
      checkMultipleDays: false
    };
  }

  // If date is invalid, use today
  if (!targetDate.isValid) {
    return {
      date: now.toISODate(),
      wasExample: false,
      original: dateStr,
      checkMultipleDays: false
    };
  }

  // If date is in the past, use today
  const startOfToday = now.startOf('day');
  if (targetDate < startOfToday) {
    console.log(`Date ${dateStr} is in the past - using today instead`);
    return {
      date: now.toISODate(),
      wasExample: false,
      original: dateStr,
      checkMultipleDays: true // Check multiple days since they may have meant "next available"
    };
  }

  // Date is valid and in the future
  return {
    date: targetDate.toISODate(),
    wasExample: false,
    original: dateStr,
    checkMultipleDays: false
  };
}

/**
 * Extract date from request
 */
function extractDateFromRequest(req) {
  const body = req.body || {};

  // Check various locations where date might be
  const possibleDates = [
    body.date,
    body.data?.date,
    body.args?.date,
    body.requested_date,
    body.data?.requested_date,
  ];

  for (const date of possibleDates) {
    if (date && typeof date === 'string') {
      console.log('Found date:', date);
      return date;
    }
  }

  // Check query params
  const query = req.query || {};
  for (const key of Object.keys(query)) {
    const value = String(query[key] || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      console.log('Found date in query:', value);
      return value;
    }
  }

  return null;
}

/**
 * Extract calendar ID from request
 */
function extractCalendarId(req) {
  const body = req.body || {};

  return body.calendar_id ||
    body.data?.calendar_id ||
    body.data?.calendarId ||
    body.args?.calendar_id ||
    body.chat?.retell_llm_dynamic_variables?.provider_calendar_id ||
    'primary';
}

/**
 * Extract window parameters
 */
function extractWindowParams(req) {
  const body = req.body || {};
  const query = req.query || {};

  // Check requested_window in body
  if (body.requested_window) {
    return {
      start_hour: body.requested_window.start_hour ?? DEFAULT_WORKDAY_START,
      end_hour: body.requested_window.end_hour ?? DEFAULT_WORKDAY_END,
      slot_duration_minutes: body.requested_window.slot_duration_minutes ?? SLOT_DURATION_MINUTES
    };
  }

  // Check query params
  return {
    start_hour: Number(query.start_hour) || DEFAULT_WORKDAY_START,
    end_hour: Number(query.end_hour) || DEFAULT_WORKDAY_END,
    slot_duration_minutes: Number(query.slot_duration) || SLOT_DURATION_MINUTES
  };
}

// -------------------- Google Calendar Setup --------------------

let cachedCalendarClient = null;

async function getCalendarClient() {
  if (cachedCalendarClient) {
    return { calendar: cachedCalendarClient };
  }

  const raw = process.env.GOOGLE_CREDS || process.env.GCAL_SERVICE_ACCOUNT_KEY || '';
  if (!raw) {
    throw new Error('Missing GOOGLE_CREDS or GCAL_SERVICE_ACCOUNT_KEY');
  }

  const creds = JSON.parse(raw);
  const jwt = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    ['https://www.googleapis.com/auth/calendar'],
    null
  );

  await jwt.authorize();
  cachedCalendarClient = google.calendar({ version: 'v3', auth: jwt });

  console.log('Calendar client initialized');
  return { calendar: cachedCalendarClient };
}

// -------------------- Calendar Operations --------------------

async function getCalendarTimezone(calendar, calendarId) {
  try {
    const res = await calendar.calendars.get({ calendarId });
    return res?.data?.timeZone || DEFAULT_TIMEZONE;
  } catch (err) {
    return DEFAULT_TIMEZONE;
  }
}

/**
 * Fetch busy times for a date range
 */
async function fetchBusyTimes(calendar, calendarId, startDate, endDate, timezone) {
  const startDT = DateTime.fromISO(startDate, { zone: timezone }).startOf('day');
  const endDT = DateTime.fromISO(endDate, { zone: timezone }).endOf('day');

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
 * Find available slots across multiple days
 */
async function findAvailableSlotsMultiDay(calendar, calendarId, startDate, daysToCheck, windowParams, timezone, maxSlots = 4) {
  const allSlots = [];
  const now = DateTime.now().setZone(timezone);

  for (let dayOffset = 0; dayOffset < daysToCheck && allSlots.length < maxSlots; dayOffset++) {
    const checkDate = DateTime.fromISO(startDate, { zone: timezone }).plus({ days: dayOffset });
    const dateStr = checkDate.toISODate();

    console.log(`Checking availability for ${dateStr}`);

    // Build window for this day
    const windowStart = checkDate.set({
      hour: windowParams.start_hour,
      minute: 0,
      second: 0
    });
    const windowEnd = checkDate.set({
      hour: windowParams.end_hour,
      minute: 0,
      second: 0
    });

    // Skip if window is entirely in the past
    if (windowEnd <= now) {
      continue;
    }

    // Fetch busy times for this day
    const busyTimes = await fetchBusyTimes(calendar, calendarId, dateStr, dateStr, timezone);

    // Convert busy times to intervals
    const busyIntervals = busyTimes.map(busy => ({
      start: DateTime.fromISO(busy.start, { zone: timezone }),
      end: DateTime.fromISO(busy.end, { zone: timezone })
    }));

    // Generate slots for this day
    let current = windowStart;
    if (current <= now) {
      // Start from next aligned slot after now
      const minutesFromNow = Math.ceil(now.diff(windowStart, 'minutes').minutes);
      const alignedMinutes = Math.ceil(minutesFromNow / SLOT_ALIGNMENT_MINUTES) * SLOT_ALIGNMENT_MINUTES;
      current = windowStart.plus({ minutes: alignedMinutes });
    }

    while (current.plus({ minutes: windowParams.slot_duration_minutes }) <= windowEnd && allSlots.length < maxSlots) {
      const slotEnd = current.plus({ minutes: windowParams.slot_duration_minutes });

      // Check if slot overlaps with any busy time
      const isAvailable = !busyIntervals.some(busy =>
        (current < busy.end && slotEnd > busy.start)
      );

      if (isAvailable) {
        allSlots.push({
          date: dateStr,
          start: current.toISO(),
          end: slotEnd.toISO(),
          display: `${checkDate.toFormat('EEE MMM d')} at ${current.toFormat('h:mm a')} - ${slotEnd.toFormat('h:mm a')}`
        });
      }

      current = current.plus({ minutes: SLOT_ALIGNMENT_MINUTES });
    }
  }

  return allSlots;
}

// -------------------- Middleware --------------------

function requireAuth(req, res, next) {
  if (!SECRET_TOKEN) {
    return next();
  }

  const auth = req.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');

  if (token !== SECRET_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

// -------------------- Routes --------------------

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

/**
 * POST /availability
 * Smart availability checker that handles Retell's date quirks
 */
app.post('/availability', requireAuth, async (req, res) => {
  try {
    console.log('POST /availability');
    console.log('Body:', JSON.stringify(req.body));

    // Extract parameters
    const dateRaw = extractDateFromRequest(req);
    const calendarId = extractCalendarId(req);
    const windowParams = extractWindowParams(req);

    console.log('Extracted date:', dateRaw);
    console.log('Calendar ID:', calendarId);
    console.log('Window params:', windowParams);

    // Get calendar client and timezone
    const { calendar } = await getCalendarClient();
    const timezone = await getCalendarTimezone(calendar, calendarId);

    // Resolve the intended date (handles Retell's example dates)
    const dateResolution = resolveIntendedDate(dateRaw, timezone);

    let slots = [];
    let message = null;

    if (dateResolution.checkMultipleDays) {
      // Check multiple days to find next available slots
      console.log(`Checking ${DAYS_TO_CHECK_AHEAD} days starting from ${dateResolution.date}`);
      slots = await findAvailableSlotsMultiDay(
        calendar,
        calendarId,
        dateResolution.date,
        DAYS_TO_CHECK_AHEAD,
        windowParams,
        timezone,
        4 // Max 4 slots
      );

      if (dateResolution.wasExample) {
        message = `Detected example date. Showing next available appointments:`;
      } else {
        message = `Original date was in the past. Showing next available appointments:`;
      }
    } else {
      // Check specific date only
      console.log(`Checking specific date: ${dateResolution.date}`);
      slots = await findAvailableSlotsMultiDay(
        calendar,
        calendarId,
        dateResolution.date,
        1, // Just check one day
        windowParams,
        timezone,
        4
      );
    }

    console.log(`Found ${slots.length} available slots`);

    // Build response
    const response = {
      success: true,
      message: message,
      date_used: dateResolution.date,
      calendar_id: calendarId,
      timezone: timezone,
      requested_window: windowParams,
      available_slots: slots
    };

    // Add debug info if date was adjusted
    if (dateResolution.wasExample || dateResolution.original !== dateResolution.date) {
      response.date_adjustment = {
        original: dateResolution.original,
        adjusted_to: dateResolution.date,
        reason: dateResolution.wasExample ? 'Example date detected' : 'Past date adjusted'
      };
    }

    res.json(response);

  } catch (error) {
    console.error('Error in /availability:', error);
    res.status(500).json({
      error: 'Failed to check availability',
      message: error.message
    });
  }
});

/**
 * POST /book
 * Book an appointment
 */
app.post('/book', requireAuth, async (req, res) => {
  try {
    console.log('POST /book');
    console.log('Body:', JSON.stringify(req.body));

    const body = req.body || {};

    // Handle Retell's nested structure
    let bookingData;
    if (body.chat && body.invocation_data) {
      // This is from Retell AI
      bookingData = body.invocation_data;
      console.log('Detected Retell format, using invocation_data:', JSON.stringify(bookingData));
    } else {
      // Direct API call
      bookingData = body;
    }

    // Extract parameters
    const calendarId = bookingData.calendar_id || bookingData.data?.calendar_id || extractCalendarId(req);
    const date = bookingData.date || bookingData.data?.date;
    const startTime = bookingData.start_time || bookingData.data?.start_time;
    const endTime = bookingData.end_time || bookingData.data?.end_time;
    const attendeeName = bookingData.attendee_name || bookingData.data?.attendee_name || 'Guest';
    const attendeeEmail = bookingData.attendee_email || bookingData.data?.attendee_email;
    const sendConfirmation = bookingData.send_confirmation || bookingData.data?.send_confirmation || false;

    // For ISO datetime bookings (from slot selection)
    const startISO = bookingData.start || bookingData.data?.start;
    const endISO = bookingData.end || bookingData.data?.end;

    console.log('Extracted booking details:', {
      calendarId,
      date,
      startTime,
      endTime,
      attendeeName,
      startISO,
      endISO
    });

    // Validate
    if (!startISO && (!date || !startTime || !endTime)) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: 'Either (start, end) OR (date, start_time, end_time)',
        received: { date, startTime, endTime, startISO, endISO }
      });
    }

    if (!calendarId) {
      return res.status(400).json({
        error: 'Missing calendar_id',
        message: 'calendar_id is required'
      });
    }

    // Get calendar
    const { calendar } = await getCalendarClient();
    const timezone = await getCalendarTimezone(calendar, calendarId);

    // Build event
    let event;

    if (startISO && endISO) {
      // Use ISO datetimes directly
      event = {
        summary: `Appointment with ${attendeeName}`,
        start: { dateTime: startISO },
        end: { dateTime: endISO }
      };
    } else {
      // Build from date and times - handle 12-hour format from Retell

      // Helper function to parse 12-hour time format
      function parseTime12Hour(timeStr, dateStr, timezone) {
        // Remove any extra whitespace
        timeStr = timeStr.trim();

        // Try to parse different formats
        // Format: "10:00 AM", "10:00AM", "10 AM", etc.
        let hour, minute = 0, isPM = false;

        // Check for AM/PM
        if (timeStr.toUpperCase().includes('PM')) {
          isPM = true;
          timeStr = timeStr.replace(/PM/i, '').trim();
        } else if (timeStr.toUpperCase().includes('AM')) {
          timeStr = timeStr.replace(/AM/i, '').trim();
        }

        // Parse hour and minute
        if (timeStr.includes(':')) {
          const parts = timeStr.split(':');
          hour = parseInt(parts[0]);
          minute = parseInt(parts[1]) || 0;
        } else {
          hour = parseInt(timeStr);
        }

        // Convert to 24-hour format
        if (isPM && hour !== 12) {
          hour += 12;
        } else if (!isPM && hour === 12) {
          hour = 0;
        }

        // Format as HH:MM
        const formattedTime = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;

        // Create DateTime object
        return DateTime.fromISO(`${dateStr}T${formattedTime}:00`, { zone: timezone });
      }

      let startDT, endDT;

      // Check if times are in 12-hour format (contain AM/PM)
      if (startTime.toUpperCase().includes('AM') || startTime.toUpperCase().includes('PM')) {
        startDT = parseTime12Hour(startTime, date, timezone);
        endDT = parseTime12Hour(endTime, date, timezone);
      } else {
        // Assume 24-hour format or HH:MM format
        startDT = DateTime.fromISO(`${date}T${startTime}:00`, { zone: timezone });
        endDT = DateTime.fromISO(`${date}T${endTime}:00`, { zone: timezone });
      }

      event = {
        summary: `Appointment with ${attendeeName}`,
        start: {
          dateTime: startDT.toISO(),
          timeZone: timezone
        },
        end: {
          dateTime: endDT.toISO(),
          timeZone: timezone
        }
      };
    }

    // Add attendee if email provided
    if (attendeeEmail) {
      event.attendees = [{ email: attendeeEmail }];
    }

    // Add description with any additional info
    event.description = `Appointment booked via Retell AI\nAttendee: ${attendeeName}`;
    if (attendeeEmail) {
      event.description += `\nEmail: ${attendeeEmail}`;
    }

    // Create the event
    const result = await calendar.events.insert({
      calendarId: calendarId,
      resource: event,
      sendNotifications: sendConfirmation && attendeeEmail ? true : false
    });

    console.log('Event created:', result.data.id);

    const response = {
      success: true,
      event_id: result.data.id,
      event_link: result.data.htmlLink,
      summary: event.summary,
      start: event.start.dateTime,
      end: event.end.dateTime,
      confirmation_sent: sendConfirmation && attendeeEmail
    };

    console.log('Sending response:', JSON.stringify(response));
    res.json(response);

  } catch (error) {
    console.error('Error in /book:', error);
    res.status(500).json({
      error: 'Failed to book appointment',
      message: error.message
    });
  }
});

// Start server
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`✅ Calendar API server running on port ${PORT}`);
    console.log(`📅 Default timezone: ${DEFAULT_TIMEZONE}`);
    console.log(`🔍 Will check ${DAYS_TO_CHECK_AHEAD} days ahead when past dates detected`);
  });
}

module.exports = app;