# Domain Model: Wiki Speedrun

**Last updated:** 2026-07-24
**Update reason:** initial — the Cloudflare migration separates public player identity, durable room membership, and replaceable WebSocket connections.

## Ubiquitous Language

| Term              | Definition                                                                                                                     | Not to be confused with                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Room              | One authoritative multiplayer session, addressed by a friendly room code and containing players, settings, rounds, and scores. | Durable Object (the infrastructure instance that hosts one Room).                    |
| Player            | The public participant identity shown inside one Room.                                                                         | Membership credential or Connection.                                                 |
| Membership        | A Player's authoritative seat and permissions in one Room, retained through the reconnect grace period.                        | Connection (a transient transport).                                                  |
| Rejoin credential | A secret, room-specific value that proves a browser may reclaim an existing Membership.                                        | Player ID (public and safe to broadcast).                                            |
| Connection        | One live WebSocket attached to a Membership; a newer Connection may replace an older one.                                      | Membership, which survives transport loss.                                           |
| Room snapshot     | The versioned, validated materialized Room and pending runtime state persisted for reconstruction.                             | Event log (events remain transition inputs but are not the durable recovery record). |
| Round preparation | The recoverable lifecycle step in which the start and goal articles are selected and persisted.                                | Countdown, which begins only after preparation succeeds.                             |
| Deadline          | A persisted future room transition, processed idempotently through the Room's single alarm schedule.                           | JavaScript timer callback.                                                           |

## Bounded Contexts

| Context               | Scope                                                                                                 | Vocabulary notes                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Game core             | Legal Room, Player, Round, scoring, and phase transitions.                                            | Time and article choices enter as data; transport and storage terms do not appear here. |
| Room runtime          | Membership, Connections, Room snapshots, Deadlines, room allocation, and cleanup.                     | Owns infrastructure effects but does not duplicate game rules.                          |
| Client session        | The browser's current Membership, stored Rejoin credential, Connection state, and rendered Room view. | A reconnect replaces the Connection, not the Player or Membership.                      |
| Wikipedia integration | Selecting round endpoints and fetching, sanitizing, and navigating article content.                   | Round preparation selects endpoints; the browser still renders article HTML.            |

## Aggregates

| Aggregate | What it is (one line)                                                                                             |
| --------- | ----------------------------------------------------------------------------------------------------------------- |
| Room      | The authoritative session aggregate whose state changes only through accepted room events.                        |
| Round     | The current or most recently completed race inside a Room, including endpoints, timing, paths, ranks, and points. |

## Notes

The Room remains product-level ephemeral even though its snapshot is durable across runtime reconstruction. “User” and “account” are not domain concepts in this project.
