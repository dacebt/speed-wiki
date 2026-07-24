# Shape: cloudflare-room-runtime — production multiplayer on Workers

**Declared:** 2026-07-24
**Cadence:** Loose
**Git strategy:** commit to main

## In scope

- One production-shaped Cloudflare Workers application serves the React SPA, health endpoint, room allocation API, and room WebSockets on the same origin.
- Each room is one SQLite-backed Durable Object with hibernatable WebSockets, a versioned validated snapshot, explicit room allocation and expiry, and one persisted idempotent alarm schedule.
- Public membership uses server-issued room credentials; reconnect, replacement sockets, kicking, deployment/runtime restart, and final grace-period cleanup preserve authoritative membership.
- Round start gains recoverable Wikipedia pair preparation before countdown while the existing pure game core, full-state synchronization, browser-side article rendering, and session scoring remain intact.
- Explicit room, frame, message-rate, and hop-growth bounds protect public correctness and the free-tier posture.
- The Node and Socket.IO runtime and stale smoke are completely replaced by production-shaped Worker development, integration tests, and an observable two-client walk.
- Cloudflare configuration and deployment automation are checked in; an actual production deployment occurs only after explicit authorization for that external action.

## Out of scope (deliberately)

- D1, KV, permanent game history, user accounts, matchmaking, public room discovery, or a separately hosted backend.
- Gameplay redesign, score-rule changes, hop-legality verification, or proxying Wikipedia article HTML through the Worker.
- Visual redesign beyond the minimum preparing, reconnecting, error, or capacity states required by the new lifecycle.
- Changes to other source projects or their vault content.

## Known risks

- This is a cross-cutting runtime migration on main; each thickening must leave one complete runnable path and avoid an indefinite dual-runtime state.
- Durable Object hibernation, unexpected shutdown, tagged socket replacement, and at-least-once alarms create lifecycle races that static typing cannot prove.
- The current public identity protocol permits host impersonation and the current room/path sizes are unbounded; credentials and bounds are production invariants, not optional follow-up hardening.
- The existing checked-in Socket.IO smoke is stale and cannot serve as a migration oracle; the observable Worker walk must replace it.

## Success signal

An authorized production Workers URL serves the SPA and two independent browser clients can create and join a room, prepare and complete a round, reconnect without identity takeover across a forced room-runtime restart, play again, and observe final room cleanup while the full repository verification passes.

## Notes

The accepted vault decision is ADR-001 and the umbrella work item is SW-001. The source checkout already contains two untracked investigation reports; direct-to-main commits must stage named files and preserve their separate ownership unless deliberately included. Cloudflare account access, remote configuration, and deployment remain explicit-approval actions.
