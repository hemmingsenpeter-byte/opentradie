import { describe, expect, it } from 'vitest';
import { CalendarProviderError, InMemoryCalendarProvider } from './calendar.js';

const at = (iso: string) => new Date(iso);
const event = (appointmentId: string, start: string, end: string) => ({
  appointmentId,
  title: 'Install power points',
  startsAt: at(start),
  endsAt: at(end),
  location: '14 Kauri Street',
});

/** Contract behaviour every CalendarProvider must meet; the fake is not a real integration. */
describe('CalendarProvider contract (in-memory fake)', () => {
  it('pushes idempotently per appointment, updates and deletes', async () => {
    const provider = new InMemoryCalendarProvider();
    const first = await provider.pushEvent(
      event('a1', '2026-11-03T20:00:00Z', '2026-11-03T21:00:00Z'),
    );
    const again = await provider.pushEvent(
      event('a1', '2026-11-03T20:00:00Z', '2026-11-03T21:00:00Z'),
    );
    expect(again).toEqual(first);
    expect(provider.pushedEvents()).toHaveLength(1);
    await provider.updateEvent(first, event('a1', '2026-11-04T20:00:00Z', '2026-11-04T21:00:00Z'));
    expect(provider.pushedEvents()[0]!.startsAt.toISOString()).toBe('2026-11-04T20:00:00.000Z');
    await provider.deleteEvent(first);
    await provider.deleteEvent(first);
    expect(provider.pushedEvents()).toEqual([]);
    await expect(
      provider.updateEvent(first, event('a1', '2026-11-04T20:00:00Z', '2026-11-04T21:00:00Z')),
    ).rejects.toBeInstanceOf(CalendarProviderError);
  });

  it('lists only external busy times in range, never its own pushed events', async () => {
    const provider = new InMemoryCalendarProvider();
    await provider.pushEvent(event('a1', '2026-11-03T20:00:00Z', '2026-11-03T21:00:00Z'));
    const ref = provider.addExternalBusy(at('2026-11-03T22:00:00Z'), at('2026-11-03T23:00:00Z'));
    provider.addExternalBusy(at('2026-11-10T22:00:00Z'), at('2026-11-10T23:00:00Z'));
    const busy = await provider.listBusyTimes(
      at('2026-11-03T00:00:00Z'),
      at('2026-11-04T00:00:00Z'),
    );
    expect(busy).toEqual([
      {
        startsAt: at('2026-11-03T22:00:00Z'),
        endsAt: at('2026-11-03T23:00:00Z'),
        externalRef: ref,
      },
    ]);
    // External events are read-only to OPENTRADIE.
    await expect(provider.deleteEvent({ provider: 'memory', externalRef: ref })).rejects.toThrow(
      /Only events pushed/,
    );
  });

  it('rejects an event that ends before it starts', async () => {
    const provider = new InMemoryCalendarProvider();
    await expect(
      provider.pushEvent(event('a2', '2026-11-03T21:00:00Z', '2026-11-03T20:00:00Z')),
    ).rejects.toThrow(CalendarProviderError);
  });
});
