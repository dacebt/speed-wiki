import { DEFAULT_ROOM_SETTINGS, type ClientIntent } from '@wikispeedrun/shared';
import { decide, type CoreIntent } from './decide.js';
import type { RoomEvent } from './events.js';
import { reduce } from './reduce.js';
import { initialRoom, type CoreRoom } from './state.js';

// Test support. Drives the pure core exactly as the shell does — decide an
// intent, then fold the emitted events through reduce — so tests exercise the
// real transitions instead of hand-built room literals. Not a *.test.ts file,
// so vitest imports it but never runs it as a suite.

export interface Applied {
  room: CoreRoom;
  events: RoomEvent[];
}

export function apply(room: CoreRoom, intent: CoreIntent): Applied {
  const decision = decide(room, intent);
  if (!decision.ok) throw new Error(`intent rejected: ${decision.code}`);
  let next = room;
  for (const event of decision.events) next = reduce(next, event);
  return { room: next, events: decision.events };
}

export function client(playerId: string, intent: ClientIntent, at = 0): CoreIntent {
  return { kind: 'client', playerId, at, intent };
}

/** A lobby with the given players; the first is host. Ids double as names. */
export function seedPlayers(...ids: string[]): CoreRoom {
  let room = initialRoom('ROOM');
  for (const id of ids) {
    room = apply(room, client(id, { type: 'room/create', playerName: id, playerId: id })).room;
  }
  return room;
}

/** Take a lobby into a racing round via the host's start and countdown finish. */
export function startRacing(
  room: CoreRoom,
  { start = 'Start', goal = 'Goal', at = 1000 } = {},
): CoreRoom {
  const host = room.players.find((p) => p.isHost)!;
  const started = apply(room, client(host.id, { type: 'game/start' }, at)).room;
  return apply(started, {
    kind: 'sys/countdownFinished',
    startArticle: start,
    goalArticle: goal,
    at: at + DEFAULT_ROOM_SETTINGS.countdownMs,
  }).room;
}
