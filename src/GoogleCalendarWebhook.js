const { google } = require('googleapis');
const { DateTime } = require('luxon');

class GoogleCalendarWebhook {
  constructor() {
    this.auth = null;
    this.calendar = null;
    this.timezone = 'America/Chicago';
  }

  async initialize(credentialsPath) {
    try {
      console.log(`📄 Attempting to load credentials from: ${credentialsPath}`);
      const credentials = require(credentialsPath);
      
      this.auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/calendar']
      });
      
      const authClient = await this.auth.getClient();
      this.calendar = google.calendar({ version: 'v3', auth: authClient });
      
      console.log('✅ Google Calendar API initialized successfully');
      return true;
    } catch (error) {
      console.error('❌ Failed to initialize Google Calendar API:', error);
      throw error;
    }
  }

  async checkAvailability(calendarId, date) {
    try {
      const startOfDay = DateTime.fromISO(date, { zone: this.timezone }).startOf('day');
      const endOfDay = startOfDay.endOf('day');
      
      const response = await this.calendar.events.list({
        calendarId: calendarId,
        timeMin: startOfDay.toISO(),
        timeMax: endOfDay.toISO(),
        singleEvents: true,
        orderBy: 'startTime',
        timeZone: this.timezone
      });

      const events = response.data.items || [];
      const busyTimes = events.map(event => ({
        start: DateTime.fromISO(event.start.dateTime || event.start.date, { zone: this.timezone }),
        end: DateTime.fromISO(event.end.dateTime || event.end.date, { zone: this.timezone })
      }));

      const availableSlots = [];
      let currentTime = startOfDay.set({ hour: 8, minute: 0 });
      const endTime = startOfDay.set({ hour: 17, minute: 0 });
      
      while (currentTime < endTime && availableSlots.length < 4) {
        const slotEnd = currentTime.plus({ minutes: 30 });
        const isAvailable = !busyTimes.some(busy => 
          (currentTime >= busy.start && currentTime < busy.end) ||
          (slotEnd > busy.start && slotEnd <= busy.end)
        );
        
        if (isAvailable) {
          availableSlots.push({
            start: currentTime.toFormat('h:mm a'),
            end: slotEnd.toFormat('h:mm a')
          });
        }
        
        currentTime = slotEnd;
      }

      const result = {};
      availableSlots.slice(0, 4).forEach((slot, index) => {
        result[`slot${index + 1}_start`] = slot.start;
        result[`slot${index + 1}_end`] = slot.end;
      });
      
      return result;
    } catch (error) {
      console.error('Error checking availability:', error);
      throw error;
    }
  }

  async bookAppointment(calendarId, date, startTime, endTime, attendeeName, attendeeEmail = null) {
    try {
      const appointmentDate = DateTime.fromISO(date, { zone: this.timezone });
      const startDateTime = this.parseTimeToDateTime(appointmentDate, startTime);
      const endDateTime = this.parseTimeToDateTime(appointmentDate, endTime);

      const event = {
        summary: `Appointment: ${attendeeName}`,
        description: `Appointment for ${attendeeName}`,
        start: {
          dateTime: startDateTime.toISO(),
          timeZone: this.timezone,
        },
        end: {
          dateTime: endDateTime.toISO(),
          timeZone: this.timezone,
        }
      };

      // Only add attendees if email is provided AND we skip sending invites
      if (attendeeEmail) {
        event.attendees = [{ email: attendeeEmail }];
        event.sendUpdates = 'none'; // Don't send email invites
      }

      const response = await this.calendar.events.insert({
        calendarId: calendarId,
        resource: event,
        sendUpdates: 'none' // Don't send any notifications
      });

      return {
        success: true,
        eventId: response.data.id,
        htmlLink: response.data.htmlLink,
        message: `Appointment booked successfully for ${attendeeName}`
      };
    } catch (error) {
      console.error('Error booking appointment:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  parseTimeToDateTime(date, timeStr) {
    const timeParts = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!timeParts) {
      throw new Error(`Invalid time format: ${timeStr}`);
    }
    
    let hours = parseInt(timeParts[1]);
    const minutes = parseInt(timeParts[2]);
    const meridiem = timeParts[3].toUpperCase();
    
    if (meridiem === 'PM' && hours !== 12) {
      hours += 12;
    } else if (meridiem === 'AM' && hours === 12) {
      hours = 0;
    }
    
    return date.set({ hour: hours, minute: minutes, second: 0, millisecond: 0 });
  }
}

module.exports = GoogleCalendarWebhook;
