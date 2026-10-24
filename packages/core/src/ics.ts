/**
 * Pure RFC 5545 (iCalendar) serializer for appointment exports (ADR 0019 amendment). Output uses
 * CRLF line endings, folds content lines at 75 octets without splitting a UTF-8 character, and
 * escapes TEXT values. SUMMARY carries the job title only; customer names, addresses and notes
 * are never included, because a feed URL can be forwarded.
 */
export interface IcsAppointment {
  id: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  status: 'proposed' | 'confirmed' | 'cancelled' | 'completed';
  updatedAt: Date;
}

export const ICS_PRODID = '-//OPENTRADIE//Appointments//EN';

/** TEXT escaping (RFC 5545 3.3.11): backslash, semicolon, comma and newlines. */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** UTC date-time form, e.g. 20261020T230000Z. */
export function icsDateTime(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

const encoder = new TextEncoder();

/** Fold a content line at 75 octets (RFC 5545 3.1); continuation lines start with one space. */
export function foldIcsLine(line: string): string {
  const parts: string[] = [];
  let current = '';
  let octets = 0;
  let limit = 75;
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (octets + size > limit) {
      parts.push(current);
      current = '';
      octets = 0;
      limit = 74; // the leading space counts towards the 75 octets
    }
    current += char;
    octets += size;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

const STATUS: Record<IcsAppointment['status'], string> = {
  proposed: 'TENTATIVE',
  confirmed: 'CONFIRMED',
  completed: 'CONFIRMED',
  cancelled: 'CANCELLED',
};

export function serializeIcs(
  appointments: readonly IcsAppointment[],
  options: { calendarName: string; now: Date },
): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${ICS_PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcsText(options.calendarName)}`,
  ];
  for (const appointment of appointments) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${appointment.id}@opentradie`,
      `DTSTAMP:${icsDateTime(options.now)}`,
      `LAST-MODIFIED:${icsDateTime(appointment.updatedAt)}`,
      `DTSTART:${icsDateTime(appointment.startsAt)}`,
      `DTEND:${icsDateTime(appointment.endsAt)}`,
      `SUMMARY:${escapeIcsText(appointment.title)}`,
      `STATUS:${STATUS[appointment.status]}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldIcsLine).join('\r\n') + '\r\n';
}
