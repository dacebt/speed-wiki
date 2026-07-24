# Capability map: Cloudflare room runtime

**Declared:** 2026-07-24
**Domain model:** `.docs/direction/speed-wiki.model.md`

## New conventions

- Static routes serve the SPA; production domain traffic lives under `/api/rooms` on the same Worker origin.
- One normalized room code addresses one Room Durable Object; infrastructure identity never enters the game core.
- Every external HTTP, WebSocket, attachment, and persisted-snapshot shape is runtime-validated before use and rejected through the shared structured error vocabulary.
- Public Player IDs, secret Rejoin credentials, and transient Connections remain distinct across shared, runtime, and client code.
- Accepted transitions persist a versioned Room snapshot and pending runtime state before any full-state broadcast; the append-only event array is not a recovery store.
- Future transitions use one persisted Deadline schedule and an idempotent alarm handler; Room runtime code does not use JavaScript timers.
- Cloudflare integration tests exercise the Worker and Durable Object through their production-shaped entrypoints, including forced eviction and alarm delivery.

## Capabilities

1. **A player opens the production-shaped app, creates a protected Room, and sees its lobby** — walking skeleton across static assets, Worker routing, Room allocation, one persisted Durable Object snapshot, hibernatable WebSocket, and server-issued Membership.
2. **An invited player joins and both players reconnect without identity takeover across Room eviction** — establishes authenticated Membership and replaceable Connection behavior before more lifecycle state depends on it.
3. **The host prepares articles and every player enters racing after a durable countdown** — adds recoverable Round preparation and the first alarm-driven phase transition across eviction.
4. **Players finish or time out a round, see authoritative results, and play again** — carries the existing game core through the complete Cloudflare transport and persisted lifecycle.
5. **Disconnect, replacement, kick, host transfer, grace expiry, and final Room cleanup behave correctly** — completes Membership lifecycle and proves an expired code can safely host a new Room.
6. **Over-limit clients receive structured rejection without growing or corrupting Room state** — enforces population, frame, message-rate, and hop-growth boundaries before public exposure.
7. **Visitors play the complete game through the authorized production Workers URL** — removes the Node and Socket.IO path, replaces the stale smoke, deploys the one supported runtime, and walks two real clients through the acceptance journey.

## Order rationale

The first capability proves the new deployment architecture with one real domain operation. Secure Membership comes next because every later phase trusts it; durable preparation and alarms then attack the highest lifecycle uncertainty. Full rounds and membership cleanup build on those foundations, public bounds close the exposure invariants, and production deployment lands only after the complete local Worker path is observable.

## Notes

The old Node runtime may coexist only as an isolated migration boundary while a complete Worker capability is being established; it is removed before production deployment. External Cloudflare account changes remain explicitly approval-gated.
