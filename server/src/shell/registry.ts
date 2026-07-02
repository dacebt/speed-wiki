import { MESSAGE_EVENT, type ServerMessage } from '@wikispeedrun/shared';
import type { Socket } from 'socket.io';
import { decide, type CoreIntent } from '../game/decide.js';
import type { RoomEvent } from '../game/events.js';
import { reduce } from '../game/reduce.js';
import { initialRoom, type CoreRoom } from '../game/state.js';
import { toRoomSync } from '../game/view.js';
import { pickPair } from './wikipedia.js';

// The room registry: all in-memory, all effectful. Applies intents through
// the pure core, reacts to the resulting events (timers, article selection),
// and broadcasts full-state syncs.

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

interface RoomRuntime {
  state: CoreRoom;
  log: RoomEvent[];
  members: Map<string, Socket>;
  countdownTimer: NodeJS.Timeout | null;
  roundTimer: NodeJS.Timeout | null;
}

const rooms = new Map<string, RoomRuntime>();

export function createRoom(): RoomRuntime {
  let code: string;
  do {
    code = Array.from(
      { length: 4 },
      () => ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)],
    ).join('');
  } while (rooms.has(code));
  const runtime: RoomRuntime = {
    state: initialRoom(code),
    log: [],
    members: new Map(),
    countdownTimer: null,
    roundTimer: null,
  };
  rooms.set(code, runtime);
  return runtime;
}

export function getRoom(code: string): RoomRuntime | undefined {
  return rooms.get(code.toUpperCase());
}

/**
 * Run an intent through the core. On success, appends and reduces the events,
 * reacts to them, and broadcasts a sync. On rejection, notifies `origin`.
 * Returns whether the intent was accepted.
 */
export function dispatch(runtime: RoomRuntime, intent: CoreIntent, origin?: Socket): boolean {
  const decision = decide(runtime.state, intent);
  if (!decision.ok) {
    if (origin) {
      send(origin, { type: 'room/error', code: decision.code, message: decision.message });
    }
    return false;
  }
  if (decision.events.length === 0) return true;
  for (const event of decision.events) {
    runtime.log.push(event);
    runtime.state = reduce(runtime.state, event);
    react(runtime, event);
  }
  broadcast(runtime);
  return true;
}

export function joinSocket(runtime: RoomRuntime, socket: Socket): void {
  runtime.members.set(socket.id, socket);
  socket.data.roomCode = runtime.state.code;
}

/** Undo a socket's membership (e.g. after a rejected join). */
export function leaveSocket(runtime: RoomRuntime, socket: Socket): void {
  runtime.members.delete(socket.id);
  delete socket.data.roomCode;
  if (runtime.state.players.length === 0 && runtime.members.size === 0) destroyRoom(runtime);
}

export function handleDisconnect(socket: Socket): void {
  const code = socket.data.roomCode as string | undefined;
  if (!code) return;
  const runtime = rooms.get(code);
  if (!runtime) return;
  runtime.members.delete(socket.id);
  dispatch(runtime, { kind: 'sys/playerDisconnected', playerId: socket.id, at: Date.now() });
  if (runtime.state.players.length === 0) destroyRoom(runtime);
}

function destroyRoom(runtime: RoomRuntime): void {
  clearTimers(runtime);
  rooms.delete(runtime.state.code);
}

function clearTimers(runtime: RoomRuntime): void {
  if (runtime.countdownTimer) clearTimeout(runtime.countdownTimer);
  if (runtime.roundTimer) clearTimeout(runtime.roundTimer);
  runtime.countdownTimer = null;
  runtime.roundTimer = null;
}

/** Effectful reactions to events: timer scheduling, article selection, and
    dropping a kicked socket from the room. */
function react(runtime: RoomRuntime, event: RoomEvent): void {
  switch (event.type) {
    case 'CountdownStarted': {
      // Pick the articles while the countdown runs; the round starts when
      // both the timer and the pick have completed.
      const articles = pickPair(event.hardMode);
      runtime.countdownTimer = setTimeout(() => {
        runtime.countdownTimer = null;
        void articles.then((pair) => {
          if (!rooms.has(runtime.state.code)) return;
          dispatch(runtime, {
            kind: 'sys/countdownFinished',
            startArticle: pair.startArticle,
            goalArticle: pair.goalArticle,
            at: Date.now(),
          });
        });
      }, Math.max(0, event.endsAt - Date.now()));
      break;
    }
    case 'RoundStarted': {
      runtime.roundTimer = setTimeout(() => {
        runtime.roundTimer = null;
        dispatch(runtime, { kind: 'sys/roundTimedOut', at: Date.now() });
      }, Math.max(0, event.deadline - Date.now()));
      break;
    }
    case 'PlayerKicked': {
      // Kick is not disconnect: the socket stays connected but leaves the room.
      // Tell it it was removed and drop it from members before the broadcast so
      // the room's syncs no longer reach it.
      const socket = runtime.members.get(event.playerId);
      if (socket) {
        send(socket, {
          type: 'room/error',
          code: 'kicked',
          message: 'You were removed from the room.',
        });
        runtime.members.delete(event.playerId);
        delete socket.data.roomCode;
      }
      break;
    }
    case 'RoundEnded':
    case 'ReturnedToLobby':
      clearTimers(runtime);
      break;
    default:
      break;
  }
}

function broadcast(runtime: RoomRuntime): void {
  const room = toRoomSync(runtime.state);
  const at = Date.now();
  for (const [playerId, socket] of runtime.members) {
    send(socket, { type: 'room/sync', room, you: playerId, at });
  }
}

function send(socket: Socket, message: ServerMessage): void {
  socket.emit(MESSAGE_EVENT, message);
}
