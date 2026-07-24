# Architecture

Multiplayer Wikipedia speedrun. Players join a room by code, all start on the same
article, race to a goal article by clicking links. Server is authoritative over all
game state; clients render state and send intents.

This document explains the architecture so it can be picked up cold. It describes the
shape and the rules of the system, not its current contents — for what messages,
events, or features exist right now, read the code; `shared/` is the entry point.

## The four pillars

**1. Shared message catalog (`shared/`).** Every client↔server message, room event,
and state shape is a named type defined once in `shared/` and imported by both sides.
This is the spine of the system: the vocabulary of everything the app does lives in
one place, and to understand the app you start by reading it. `shared/` contains
transport-neutral types, catalogs, constants, and their small pure validators; it
imports nothing from another workspace package.

**2. Event-sourced functional core (`game/`).** A room's state is a pure fold
over its event log: intents are validated into events, events are reduced into state,
and all game rules (lifecycle, scoring, timing decisions) live in pure functions.
No I/O, no sockets, no timers, and no reading the clock inside the core — time enters
as data on intents and events. Both runtime shells depend on the behavior-only
`@wikispeedrun/game` package; browser code never does.

**3. MVU client with feature slices (`client/`).** Client state is a reducer over
server messages and local UI events; views are functions of state. Code is organized
by feature (one folder per screen or capability), not by layer, so working on a
feature means working in one folder. The Wikipedia viewer — fetching, sanitizing, and
link interception — is one such slice, deliberately isolated so its fetching can move
behind the server later without touching anything else.

**4. Explicit runtime shells.** The complete legacy product remains runnable through
`pnpm dev:legacy`: one Node process, a Socket.IO edge, an in-memory room registry,
and JavaScript timers. The production-shaped path runs through `pnpm dev:worker`:
Vite serves the same SPA with a native-WebSocket transport, a same-origin Worker
allocates a named Room Durable Object, and that object validates and persists a
versioned Room snapshot before sending a full sync. The runtime is selected at build
time, so Socket.IO is absent from the Worker browser bundle and neither shell routes
through the other. The Worker path covers protected Room creation, invited Membership
joining, same-identity reconnection across Durable Object eviction, deterministic
one-live-Connection replacement, disconnect grace and expiry, host removal of active
or away Memberships, and authenticated host Start through recoverable article
preparation, a durable countdown, one authoritative racing round, results, and host
replay.

Invited joining uses a two-step durable handshake. The browser gives the join POST one
high-entropy attempt ID and a monotonic request generation. An ambiguous-response retry
reuses the ID at a higher generation; an older or equal request cannot overwrite a
newer result. The Room stores an unpromoted reservation with a server-generated Player
ID and only the digest of a fresh server-issued Rejoin credential. No Player or
Membership is visible yet. Before authenticating, the browser stores that Membership
and its discoverable last-Room pointer; a storage failure opens no socket. The first
WebSocket that proves the current credential transactionally promotes the reservation
into Room state and only then broadcasts it. If its first sync is lost, reload can
reclaim the promoted Membership from the pre-auth browser record. A completed attempt
cannot be replayed because the raw credential is never recoverable from server storage.

Worker Membership presence is durable, fenced, bounded, and ephemeral. Each Membership
stores only its credential digest, current Connection ID, and fixed-window message
counter. Authentication first claims a new Connection ID and one of the Membership's
20 messages per 10-second window in the same transaction; only that exact prior
connection may be replaced, and a later close from the displaced socket cannot mark the
Player away or spend its quota. The counter survives connection replacement and
Durable Object eviction. A real close or error marks the Player away and adds a
45-second grace deadline keyed to the closed Connection. Reauthentication within grace
preserves the Player ID, score, path, host authority, and message window while canceling
eviction. The grace instant itself is expired: authentication must commit strictly
before it, even if alarm delivery is late. Every authenticated mutation also rechecks
the attachment Connection ID and spends quota inside the transaction that decides and
writes, so queued work from a displaced socket is inert. Expiry folds `PlayerLeft`,
transfers host authority through the game core, and ends a race if the departed Player
was its final unfinished racer. Expiry of the final Membership deletes the Room
snapshot so the code is absent and may be claimed again. In the lobby, a host kick
commits Player, Membership, join-attempt, and deadline removal before the target
receives its terminal signal; kicked and invalid clients delete their browser
credential, while connection-replaced and policy-closed clients retain it.

A Room has eight occupied-or-pending Membership slots. A new join reserves a slot
transactionally before returning its credential, while a newer-generation retry of the
same pending attempt remains legal at capacity. Each WebSocket frame is capped at 4,096
raw UTF-8 bytes before parsing, for both text and binary input. Oversized or rate-limited
frames receive a structured error and policy close without revoking the Membership;
the close then follows the ordinary away/grace lifecycle. A Player may commit 100 hops
per round. Hop 101, including a goal hop, is a visible nonterminal
`hop-limit-reached` error and leaves authoritative Room state unchanged. Snapshot v6
persists and validates the Membership, quota-window, and hop-path bounds.

Worker Round preparation is an explicit Room phase. Accepted Start persists the
preparing Room, one generation token, the chosen difficulty/category, and one typed
preparation Deadline before broadcasting. The Durable Object alarm performs article
selection; a random selection either succeeds within its bounded retry budget or
returns the Room to the lobby with `article-fetch-failed`, never a curated substitute.
Selection success persists the common pair, countdown state, and replacement countdown
Deadline before broadcasting. That alarm is the sole transition into racing: it
rechecks the preparation token, folds the core transition, replaces the countdown
Deadline with a deterministic Round-identity timeout, and persists both racing state
and its alarm before sync. Hops, give-up, and host replay re-run core authorization
inside a storage transaction. Ordinary hops preserve the timeout; an all-done action
persists results and clears it. A due timeout alarm is the other authoritative route
to results. Duplicate, stale, or early alarm work is inert and a future Deadline is
re-armed after early delivery. The two-browser smoke observes the complete public path
through results and replay. Forced eviction remains integration evidence:
`cloudflare:test` evicts the racing Room before timeout while sockets stay attached.
The browser surface has no test-only route for controlling Durable Object lifetime.

## Rules

Placement — where new work goes:

- A new client↔server interaction starts as a type in `shared/`, gets its game logic
  in `game/`, its transport in the active shell, and its rendering in one client feature.
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
- Transport code stays at the edges. Membership credentials are shell concerns and
  never enter the game core or a `RoomSync`.
- Persisted bytes are untrusted: every Durable Object storage load is parsed before
  it enters the core or a client view. Accepted state is persisted before broadcast.
- A public Player ID identifies a seat; only the secret, one-way-digested Rejoin
  credential proves Membership. A live Connection is transient and hibernation-safe.
- A join attempt ID is retry correlation, not authority. It never enters game-core Room state,
  URLs, logs, socket attachments, or syncs, and it cannot reclaim a promoted Membership.
- Join request generations only increase, and every pending or promoted attempt owns a
  distinct Player ID. The Room rejects stale rotations; snapshot validation rejects aliases.
- Worker future transitions have one owner: the persisted typed Deadline schedule and
  Durable Object alarm. Snapshot v6 allows at most one phase transition plus concurrent
  Membership grace deadlines. The alarm targets the deterministic earliest item,
  processes one due item, and re-arms from persisted state. Worker Room code never uses
  JavaScript timers, and an async preparation result must still own the persisted
  generation token before it may change Room state.

## Standing decisions

- **Server-authoritative, ephemeral Rooms.** Scores remain per-session and no permanent
  match history is retained. The Cloudflare runtime stores a versioned snapshot in
  one SQLite-backed Durable Object per Room so eviction does not erase a live session;
  this is lifecycle durability, not a user database. A Room with no Memberships is
  deleted rather than retained as permanent history.
- **Cloudflare is the production target.** Static assets, HTTP allocation, and
  WebSockets share one Worker origin. Room code names the Durable Object. The
  declarative `exports` configuration owns the SQLite class lifecycle; no D1, KV,
  account model, or separate backend is introduced.
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
