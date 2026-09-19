import { google } from 'googleapis';

function getAuth() {
  return new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
}

export async function createCalendarEvent(params: {
  title: string;
  startIso: string;
  durationMinutes?: number;
  description?: string;
}) {
  const auth = getAuth();
  const cal = google.calendar({ version: 'v3', auth });

  const start = new Date(params.startIso);
  const end = new Date(start.getTime() + (params.durationMinutes || 60) * 60_000);

  const event = await cal.events.insert({
    calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
    requestBody: {
      summary: params.title,
      description: params.description || '',
      start: { dateTime: start.toISOString(), timeZone: 'America/Sao_Paulo' },
      end: { dateTime: end.toISOString(), timeZone: 'America/Sao_Paulo' },
    },
  });

  return event.data;
}
