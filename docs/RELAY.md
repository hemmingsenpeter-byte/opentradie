# Relay and remote access (hybrid profile)

Status: the relay **contract, ingress and a local delivery harness are implemented and tested**; a public multi-customer relay, tunnel or managed relay is **not built**. This page documents the options and their privacy implications so the choice is deliberate.

The relay is not an agent. Eventually it should: receive authenticated external events (for example provider webhooks), validate signatures, deduplicate, queue durably, forward to the correct authorised runtime, handle disconnections, reconcile on reconnect and expose minimal status. Local instances should only make **outbound** authenticated connections. The OpenClaw Gateway and PostgreSQL must never be exposed publicly.

## Options

| Option                                                                        | How it works                                                                         | Privacy / security                                                                                                            | Cost of operation                        |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Direct provider callback                                                      | Provider calls an HTTPS endpoint on the Mac mini                                     | Mac mini is internet-exposed (port forwarding or public IP); the provider sees the endpoint; you validate signatures yourself | Needs a stable address, TLS and patching |
| Secure tunnel (for example Tailscale or Cloudflare Tunnel, operator-supplied) | Local machine dials out; public hostname maps to the local API                       | Tunnel operator can observe traffic metadata and, for terminating tunnels, plaintext; no zero-exposure claim                  | Low; depends on a third party            |
| Managed relay                                                                 | A small cloud service queues events; the local app pulls over an outbound connection | Relay holds event payloads in plaintext unless end-to-end encrypted (not designed yet); one more party to trust and secure    | Highest; multi-customer relay deferred   |

No option eliminates plaintext exposure to every intermediary, and none is claimed to.

## Phase 1 scope

Implemented in `packages/platform/src/relay.ts` and `POST /relay/v1/events`, tested in `tests/integration/queue-and-relay.test.ts`:

- The route exists only when `RELAY_SHARED_SECRET` (at least 32 characters) is set. Requests carry `x-opentradie-signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`; signatures older or newer than 5 minutes are rejected (401).
- The envelope (version 1) is strict: `tenantId`, `source` (`mock_email`, `mock_sms` or `test_webhook`), `eventId`, `eventType` (`message.received`), `occurredAt` and a payload of `from`, optional `subject` and `text`. A `tenantId` other than the runtime's is rejected (403).
- Events are stored once in `relay_inbox` (unique per tenant, source and event id) and a `relay.process` job is queued in the same transaction. A redelivery is acknowledged without reprocessing (202); the same event id with different content is a 409. The job records an inbound communication, matches a customer by exact email, adds a knowledge item and audits it.
- `forwardRelayEvent` is the sending side of the harness: signed outbound delivery with bounded exponential retry (5 attempts, 500 ms base), retrying network failures, 5xx, 408 and 429 and stopping on other client errors.

No real provider (email, SMS, WhatsApp) is connected. A public multi-customer relay is deferred. Whatever is built must preserve: one authoritative runtime, exactly-once-effect processing via idempotency keys, and privacy-mode enforcement independent of how events arrive.
