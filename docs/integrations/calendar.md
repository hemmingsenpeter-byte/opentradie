# Calendar integration

Status: **contract and in-memory fake Implemented and tested; Google Calendar and Microsoft 365 providers Scaffolded (none exists).** The fake is not evidence that any real calendar works. See [ADR 0019](../adr/0019-scheduling-and-reminders.md).

## Authority

| Data                            | Authority                         | Direction                        |
| ------------------------------- | --------------------------------- | -------------------------------- |
| Job appointments (time, status) | OPENTRADIE (`appointments` table) | Out: pushed to the calendar      |
| Owner's other commitments       | External calendar                 | In: busy intervals only          |
| Edits made to a pushed event    | OPENTRADIE wins                   | Shown as a conflict, not applied |

- An external calendar never creates, moves or cancels an OPENTRADIE appointment.
- Busy times read from an external calendar block availability like an appointment, but carry no title, attendees or description into OPENTRADIE.
- Pushed events contain the appointment title, times and address snapshot only. Customer contact details, notes and prices are never pushed.

## Contract

`packages/platform/src/calendar.ts` defines `CalendarProvider`:

| Method                    | Behaviour                                                                               |
| ------------------------- | --------------------------------------------------------------------------------------- |
| `pushEvent(event)`        | Creates the event, or returns the existing one for the same appointment id (idempotent) |
| `updateEvent(ref, event)` | Replaces time, title and location of an event OPENTRADIE pushed                         |
| `deleteEvent(ref)`        | Removes an event OPENTRADIE pushed; deleting an already deleted event succeeds          |
| `listBusyTimes(from, to)` | Busy intervals overlapping the range, excluding events OPENTRADIE pushed                |

Errors use `CalendarProviderError` with codes `NOT_FOUND`, `AUTH_EXPIRED`, `RATE_LIMITED`, `UNAVAILABLE`, `INVALID`. The provider's event id is stored in `appointments.external_calendar_ref` with `external_calendar_provider` (unique per tenant and provider).

`InMemoryCalendarProvider` implements the contract for tests (`packages/platform/src/calendar.test.ts`).

## ICS export (implemented)

Implemented and tested with automated tests only ([ADR 0019 amendment](../adr/0019-scheduling-and-reminders.md)).
Settings › Calendar feed creates a private subscription URL (`/calendar/feed/<token>.ics`), shown once;
rotate it to replace a lost or shared link, revoke it to stop it at once. Events carry the job title
and times only. Each appointment can also be downloaded as `/api/appointments/<id>.ics` when signed in.
Subscribing from Apple, Google or Outlook calendar has not been tried; refresh intervals are up to
the calendar app (often hours).

## Not done yet

- No OAuth, token storage or real provider adapter. Credentials would live encrypted in `provider_connections`.
- Push, update and delete are not yet called from the appointment routes; when they are, they go through the outbox on the job queue (ADR 0012) so a provider outage never blocks a booking.
- Busy times are not yet merged into `GET /api/scheduling/availability`.
- Failure modes to cover when a provider is added: token expiry, rate limits, time zone and DST mismatches, and events edited outside OPENTRADIE.
