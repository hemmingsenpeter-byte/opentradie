/**
 * CalendarProvider: the adapter contract for future Google Calendar / Microsoft 365 sync.
 *
 * Authority (docs/integrations/calendar.md, ADR 0019): OPENTRADIE is authoritative for job
 * appointments. Appointments are pushed OUT to an external calendar; external calendars
 * contribute BUSY TIMES ONLY and never create, move or cancel an OPENTRADIE appointment.
 *
 * Status: contract and in-memory fake are Implemented and tested; real providers are
 * Scaffolded (none exists). The fake is never evidence of a working provider integration.
 */

export interface CalendarEventInput {
  /** OPENTRADIE appointment id; providers store it so pushes are idempotent. */
  appointmentId: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  /** Address snapshot. Customer contact details and notes are never pushed. */
  location: string | null;
}

export interface CalendarEventRef {
  provider: string;
  /** The provider's event id, stored in appointments.external_calendar_ref. */
  externalRef: string;
}

export interface CalendarBusyTime {
  startsAt: Date;
  endsAt: Date;
  /** The provider's event id, if exposed; never its title or attendees. */
  externalRef: string | null;
}

export class CalendarProviderError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'AUTH_EXPIRED' | 'RATE_LIMITED' | 'UNAVAILABLE' | 'INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'CalendarProviderError';
  }
}

export interface CalendarProvider {
  readonly name: string;
  /** Create the event, or return the existing one for this appointment id (idempotent). */
  pushEvent(event: CalendarEventInput): Promise<CalendarEventRef>;
  /** Replace time, title and location of a previously pushed event. */
  updateEvent(ref: CalendarEventRef, event: CalendarEventInput): Promise<void>;
  /** Remove a pushed event; deleting an already deleted event succeeds. */
  deleteEvent(ref: CalendarEventRef): Promise<void>;
  /**
   * Busy intervals overlapping [from, to). Events pushed by OPENTRADIE are excluded so an
   * appointment never conflicts with its own mirror.
   */
  listBusyTimes(from: Date, to: Date): Promise<CalendarBusyTime[]>;
}

interface StoredEvent extends CalendarEventInput {
  externalRef: string;
  ownedByOpentradie: boolean;
}

/** Deterministic in-memory provider for tests and local development. */
export class InMemoryCalendarProvider implements CalendarProvider {
  readonly name = 'memory';
  private readonly events = new Map<string, StoredEvent>();
  private counter = 0;

  async pushEvent(event: CalendarEventInput): Promise<CalendarEventRef> {
    assertEvent(event);
    for (const stored of this.events.values())
      if (stored.ownedByOpentradie && stored.appointmentId === event.appointmentId)
        return { provider: this.name, externalRef: stored.externalRef };
    const externalRef = `mem-${++this.counter}`;
    this.events.set(externalRef, { ...event, externalRef, ownedByOpentradie: true });
    return { provider: this.name, externalRef };
  }

  async updateEvent(ref: CalendarEventRef, event: CalendarEventInput): Promise<void> {
    assertEvent(event);
    const stored = this.events.get(ref.externalRef);
    if (!stored || !stored.ownedByOpentradie)
      throw new CalendarProviderError('NOT_FOUND', 'Calendar event not found.');
    this.events.set(ref.externalRef, { ...stored, ...event, externalRef: ref.externalRef });
  }

  async deleteEvent(ref: CalendarEventRef): Promise<void> {
    const stored = this.events.get(ref.externalRef);
    if (stored && !stored.ownedByOpentradie)
      throw new CalendarProviderError(
        'INVALID',
        'Only events pushed by OPENTRADIE can be deleted.',
      );
    this.events.delete(ref.externalRef);
  }

  async listBusyTimes(from: Date, to: Date): Promise<CalendarBusyTime[]> {
    return [...this.events.values()]
      .filter((event) => !event.ownedByOpentradie)
      .filter((event) => event.startsAt < to && from < event.endsAt)
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
      .map((event) => ({
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        externalRef: event.externalRef,
      }));
  }

  /** Test helper: an event the owner created directly in their external calendar. */
  addExternalBusy(startsAt: Date, endsAt: Date): string {
    const externalRef = `ext-${++this.counter}`;
    this.events.set(externalRef, {
      appointmentId: '',
      title: 'Busy',
      startsAt,
      endsAt,
      location: null,
      externalRef,
      ownedByOpentradie: false,
    });
    return externalRef;
  }

  /** Test helper: pushed events, for assertions. */
  pushedEvents(): StoredEvent[] {
    return [...this.events.values()].filter((event) => event.ownedByOpentradie);
  }
}

function assertEvent(event: CalendarEventInput) {
  if (!(event.endsAt > event.startsAt))
    throw new CalendarProviderError('INVALID', 'An event must end after it starts.');
}
