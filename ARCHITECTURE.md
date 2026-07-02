# Architecture

Multiplayer Wikipedia speedrun. Players join a room by code, all start on the same
article, race to a goal article by clicking links. Server is authoritative over all
game state; clients render state and send intents.

This document is the structure to follow. Every rule here is mechanical on purpose:
"where does this go" and "what is not allowed" should never require judgment.

## The three pillars

1. **Shared message catalog** (`shared/`) — every client↔server message is a named,
   typed message defined in one place. The catalog is the spine of the system: to
   understand what the app does, read the catalog.
2. **Event-sourced functional core** (`server/game/`) — a room's state is a pure fold
   over its event log. All game rules live in pure functions. No I/O, no sockets, no
   timers, no `Date.now()` inside the core.
3. **MVU client** (`client/`) — client state is a reducer over server messages + local
   UI events. Views are functions of state. Feature folders keep each screen's code
   together.

## Layout

```
wikispeedrun/
  shared/                  # THE CONTRACT — types only, no logic, no dependencies
    messages.ts            #   client→server intents, server→client messages
    events.ts              #   room event log entries (server-internal shape, shared for replay/stats)
    state.ts               #   RoomState, PlayerState, GamePhase, scoring types
  server/
    game/                  # FUNCTIONAL CORE — pure, no imports from outside game/ + shared/
      reduce.ts            #   (RoomState, RoomEvent) -> RoomState
      decide.ts            #   (RoomState, Intent, now) -> RoomEvent[] | Rejection
      score.ts             #   placement + points
      select.ts            #   derived views of state (leaderboard, phase checks)
    rooms.ts               # IMPERATIVE SHELL — room registry, event logs, timer scheduling
    socket.ts              # transport: socket message -> intent -> decide -> append -> broadcast
    wiki.ts                # word-pair selection (curated pool + hard-mode true random)
    index.ts               # boot
  client/
    src/
      app/                 # socket client, root reducer, routing between phases
      features/            # VERTICAL SLICES — one folder per screen/capability
        lobby/             #   create/join room, player list, customization, countdown
        race/              #   sidebar (timers, click counts), race chrome
        viewer/            #   wikipedia fetch + sanitize + link interception
        results/           #   placements, points, play-again
      shared/              # cross-slice UI primitives only — promoted deliberately, never by default
  prototype/               # throwaway spikes; nothing imports from here
```

## Placement rules

- **New client↔server interaction** → add a message type to `shared/messages.ts`, an
  event to `shared/events.ts` if it changes room state, a branch in `decide.ts`/
  `reduce.ts`, and handling in the client feature that renders it. That list is the
  whole checklist; if a change needs a file outside it, the design is wrong.
- **New game rule** (scoring change, round timer, DNF handling) → `server/game/` only.
- **New screen or player-facing capability** → new folder in `client/src/features/`.
- **Code needed by two client features** → stays duplicated until it has three call
  sites or is provably identical; then promote to `client/src/shared/`.
- **Experiment/spike** → `prototype/`. Prototypes are write-only; production code never
  imports from them.

## Legality rules (the "never" list)

- `shared/` contains types and pure constants only. It imports nothing.
- `server/game/` imports only from `shared/` and within itself. No socket types, no
  fetch, no timers, no `Date.now()` — time enters as a parameter on intents/events.
- State changes happen only by appending an event and re-reducing. No mutation of
  `RoomState` outside `reduce.ts`.
- The client never computes authority: no client-side placement, timing, or win
  detection. Client sends intents; server decides; client renders what it's told.
- Timestamps are server-assigned, always. Client-sent times are ignored.
- Sockets appear in `server/socket.ts` and `client/src/app/` only.

## The message catalog seed

Intents (client → server): `CreateRoom`, `JoinRoom`, `LeaveRoom`, `SetCustomization`,
`StartGame`, `ReportHop`, `GiveUp`, `PlayAgain`.

Server → client: `RoomSync` (full room state — the only state-bearing message),
`Rejected` (intent refused, with reason), `Countdown` (tick).

Room events (internal log): `RoomCreated`, `PlayerJoined`, `PlayerLeft`,
`CustomizationSet`, `GameStarted`, `HopRecorded`, `PlayerFinished`, `PlayerGaveUp`,
`RoundExpired`, `RoundScored`, `RematchStarted`.

Grow these lists as features land; a message or event that isn't in the catalog
doesn't exist.

## Decisions already made

- **Server-authoritative, rooms in memory, no DB.** Scores are per-session. One
  stateful Node process; do not deploy serverless.
- **v1 trusts client hop reports.** `decide.ts` treats hop legality as a validation
  step that is currently a no-op — the seam exists so server-side link verification
  can be added without restructuring.
- **Client fetches Wikipedia directly** (REST API, CORS-open), isolated in the
  `viewer` slice so it can move behind the server later.
- **Word pairs**: goal words from a curated well-connected pool; "hard mode" uses true
  random for both. Start words can be random either way.
- **Round timer** (~10 min, configurable per room) ends the round; unfinished players
  are DNF and score below all finishers.
- **Full event log kept per room for the session** — it is the source for results,
  stats, and any future replay. No snapshots, no persistence; the log dies with the
  room.
- **Stack**: Node + TypeScript + Socket.io; Vite + React client; single repo.
