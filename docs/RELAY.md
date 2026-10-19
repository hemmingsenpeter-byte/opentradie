# Relay and remote access (hybrid profile)

Status: **Planned.** v0.1 contains no relay. This page documents the options and their privacy implications so the choice is deliberate.

The relay is not an agent. Eventually it should: receive authenticated external events (for example provider webhooks), validate signatures, deduplicate, queue durably, forward to the correct authorised runtime, handle disconnections, reconcile on reconnect and expose minimal status. Local instances should only make **outbound** authenticated connections. The OpenClaw Gateway and PostgreSQL must never be exposed publicly.

## Options

| Option                                                                        | How it works                                                                         | Privacy / security                                                                                                            | Cost of operation                        |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Direct provider callback                                                      | Provider calls an HTTPS endpoint on the Mac mini                                     | Mac mini is internet-exposed (port forwarding or public IP); the provider sees the endpoint; you validate signatures yourself | Needs a stable address, TLS and patching |
| Secure tunnel (for example Tailscale or Cloudflare Tunnel, operator-supplied) | Local machine dials out; public hostname maps to the local API                       | Tunnel operator can observe traffic metadata and, for terminating tunnels, plaintext; no zero-exposure claim                  | Low; depends on a third party            |
| Managed relay                                                                 | A small cloud service queues events; the local app pulls over an outbound connection | Relay holds event payloads in plaintext unless end-to-end encrypted (not designed yet); one more party to trust and secure    | Highest; multi-customer relay deferred   |

No option eliminates plaintext exposure to every intermediary, and none is claimed to.

## Phase 1 scope

Relay contracts, a local test harness for event delivery, and tests for idempotent processing and basic retry. A public multi-customer relay is deferred. Whatever is built must preserve: one authoritative runtime, exactly-once-effect processing via idempotency keys, and privacy-mode enforcement independent of how events arrive.
