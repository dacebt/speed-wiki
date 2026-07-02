# Architecture

Multiplayer Wikipedia speedrun. Players join a room by code, all start on the same
article, race to a goal article by clicking links. Server is authoritative over all
game state; clients render state and send intents.

This document explains the architecture so it can be picked up cold. It describes the
shape and the rules of the system, not its current contents — for what messages,
events, or features exist right now, read the code; `shared/` is the entry point.

## The three pillars

**1. Shared message catalog (`shared/`).** Every client↔server message, room event,
and state shape is a named type defined once in `shared/` and imported by both sides.
This is the spine of the system: the vocabulary of everything the app does lives in
one place, and to understand the app you start by reading it. Nothing in `shared/`
has behavior — types and pure constants only, importing nothing.

**2. Event-sourced functional core (`server/game/`).** A room's state is a pure fold
over its event log: intents are validated into events, events are reduced into state,
and all game rules (lifecycle, scoring, timing decisions) live in pure functions.
No I/O, no sockets, no timers, and no reading the clock inside the core — time enters
as data on intents and events. Everything effectful (socket transport, timer
scheduling, the room registry) lives in a thin imperative shell around it. The event
log is also the record of the round: results and stats are derived from it, and it
dies with the room — no persistence, no snapshots.

**3. MVU client with feature slices (`client/`).** Client state is a reducer over
server messages and local UI events; views are functions of state. Code is organized
by feature (one folder per screen or capability), not by layer, so working on a
feature means working in one folder. The Wikipedia viewer — fetching, sanitizing, and
link interception — is one such slice, deliberately isolated so its fetching can move
behind the server later without touching anything else.

## Rules

Placement — where new work goes:

- A new client↔server interaction starts as a type in `shared/`, gets its game logic
  in the core, its transport in the shell, and its rendering in one client feature.
  If a change needs to touch places beyond those, the design is wrong.
- Game rules change only in the core. Screens and player-facing capabilities are new
  client feature folders. Spikes go in `prototype/`, which nothing imports from.
- Code shared between client features earns promotion to a shared folder by repeated
  proven need, never by anticipation.

Legality — what is never allowed:

- No I/O or clock access in the game core; no game logic in the shell or handlers.
- Room state changes only by appending an event and reducing. No mutation elsewhere.
- The client never computes authority: no client-side placement, timing, or win
  detection. Clients send intents, the server decides, clients render what they're
  told. Timestamps are server-assigned; client-sent times are ignored.
- Socket code stays at the edges — one place on the server, one on the client.

## Standing decisions

- **Server-authoritative, rooms in memory, no database.** Scores are per-session.
  One stateful Node process; not deployable serverless.
- **The client fetches Wikipedia directly** (its REST API is CORS-open). The seam to
  proxy through the server exists for when caching or hop verification is wanted;
  relatedly, hop legality is a validation step in the core that v1 leaves as a no-op.
- **Full state sync, not deltas.** The server broadcasts complete room state on
  change. Rooms are small; eliminating client-drift bugs is worth the bytes.

## Why this shape

Complexity in this app lives in game lifecycle — who's in the room, what phase the
round is in, who finished when — not in integrations (there are two: the socket and
Wikipedia). So the architecture spends its structure on the lifecycle: an explicit
message vocabulary and a pure, replayable state machine, rather than ports and
adapters around infrastructure that will never be swapped.
