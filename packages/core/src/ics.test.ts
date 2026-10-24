import { describe, expect, it } from 'vitest';
import { escapeIcsText, foldIcsLine, icsDateTime, serializeIcs } from './ics.js';

const octets = (line: string) => new TextEncoder().encode(line).length;

describe('RFC 5545 serializer', () => {
  it('escapes backslash, semicolon, comma and newlines in TEXT', () => {
    expect(escapeIcsText('a\\b;c,d\ne\r\nf')).toBe('a\\\\b\\;c\\,d\\ne\\nf');
  });

  it('formats UTC date-times with a Z suffix', () => {
    expect(icsDateTime(new Date('2026-10-20T23:05:09.123Z'))).toBe('20261020T230509Z');
  });

  it('folds at 75 octets without splitting UTF-8 characters', () => {
    const line = `SUMMARY:${'Wharekai māori ✓ '.repeat(12)}`;
    const folded = foldIcsLine(line);
    const parts = folded.split('\r\n');
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(octets(part)).toBeLessThanOrEqual(75);
    for (const part of parts.slice(1)) expect(part.startsWith(' ')).toBe(true);
    expect(parts.map((part, i) => (i ? part.slice(1) : part)).join('')).toBe(line);
    expect(foldIcsLine('SHORT:line')).toBe('SHORT:line');
  });

  it('writes a VCALENDAR with stable UIDs, CRLF endings, statuses and the job title only', () => {
    const ics = serializeIcs(
      [
        {
          id: 'a1',
          title: 'Rewire garage, stage 1; west wall',
          startsAt: new Date('2026-11-02T20:00:00Z'),
          endsAt: new Date('2026-11-02T22:00:00Z'),
          status: 'proposed',
          updatedAt: new Date('2026-10-20T00:00:00Z'),
        },
        {
          id: 'a2',
          title: 'Heat pump',
          startsAt: new Date('2026-11-03T20:00:00Z'),
          endsAt: new Date('2026-11-03T21:00:00Z'),
          status: 'cancelled',
          updatedAt: new Date('2026-10-20T00:00:00Z'),
        },
      ],
      { calendarName: 'Harbour Electrical appointments', now: new Date('2026-10-20T01:02:03Z') },
    );
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//OPENTRADIE//')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(ics).toContain('UID:a1@opentradie\r\n');
    expect(ics).toContain('DTSTAMP:20261020T010203Z\r\n');
    expect(ics).toContain('DTSTART:20261102T200000Z\r\nDTEND:20261102T220000Z\r\n');
    expect(ics).toContain('SUMMARY:Rewire garage\\, stage 1\\; west wall\r\n');
    expect(ics).toContain('STATUS:TENTATIVE');
    expect(ics).toContain('STATUS:CANCELLED');
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
  });
});
