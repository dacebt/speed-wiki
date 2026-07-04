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

// How long a dropped player's slot is held before the grace window lapses and
// they are removed for real. A refresh or wifi blip reconnects in seconds; this
// window covers that without stranding a room on a player who closed the tab.
const REJOIN_GRACE_MS = 45_000;

interface RoomRuntime {
  state: CoreRoom;
  log: RoomEvent[];
  /** playerId → the live socket currently attached to that player. */
  members: Map<string, Socket>;
  /** playerId → pending grace-window removal for a dropped player. */
  graceTimers: Map<string, NodeJS.Timeout>;
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
    graceTimers: new Map(),
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

/** Attach a socket to a player. A reconnecting player arrives on a fresh socket,
    so this rebinds the transport handle and cancels any pending grace removal. */
export function joinSocket(runtime: RoomRuntime, socket: Socket, playerId: string): void {
  runtime.members.set(playerId, socket);
  socket.data.roomCode = runtime.state.code;
  socket.data.playerId = playerId;
  cancelGrace(runtime, playerId);
}

/** Undo a socket's membership (e.g. after a rejected join). */
export function leaveSocket(runtime: RoomRuntime, socket: Socket): void {
  const playerId = socket.data.playerId as string | undefined;
  if (playerId) runtime.members.delete(playerId);
  delete socket.data.roomCode;
  delete socket.data.playerId;
  if (runtime.state.players.length === 0 && runtime.members.size === 0) destroyRoom(runtime);
}

export function handleDisconnect(socket: Socket): void {
  const code = socket.data.roomCode as string | undefined;
  const playerId = socket.data.playerId as string | undefined;
  if (!code || !playerId) return;
  const runtime = rooms.get(code);
  if (!runtime) return;
  // A fast reconnect can rebind the player to a newer socket before this old
  // socket's disconnect arrives. If so, this is a stale disconnect for a player
  // who is once again live — ignore it entirely, or we would mark an active
  // player away and never clear it.
  if (runtime.members.get(playerId) !== socket) return;
  runtime.members.delete(playerId);
  // Hold the slot: mark away now, and schedule the real removal for when the
  // grace window lapses without a rejoin.
  dispatch(runtime, { kind: 'sys/playerAway', playerId, at: Date.now() });
  scheduleGrace(runtime, playerId);
}

/** After the grace window, a still-absent player leaves for real (host transfer,
    round-end recheck). A rejoin in the meantime cancels this. */
function scheduleGrace(runtime: RoomRuntime, playerId: string): void {
  cancelGrace(runtime, playerId);
  const code = runtime.state.code;
  const timer = setTimeout(() => {
    runtime.graceTimers.delete(playerId);
    if (!rooms.has(code)) return;
    if (runtime.members.has(playerId)) return;
    dispatch(runtime, { kind: 'sys/playerLeft', playerId, at: Date.now() });
    if (runtime.state.players.length === 0) destroyRoom(runtime);
  }, REJOIN_GRACE_MS);
  runtime.graceTimers.set(playerId, timer);
}

function cancelGrace(runtime: RoomRuntime, playerId: string): void {
  const timer = runtime.graceTimers.get(playerId);
  if (timer) {
    clearTimeout(timer);
    runtime.graceTimers.delete(playerId);
  }
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
  for (const timer of runtime.graceTimers.values()) clearTimeout(timer);
  runtime.graceTimers.clear();
}

/** Effectful reactions to events: timer scheduling, article selection, and
    dropping a kicked socket from the room. */
function react(runtime: RoomRuntime, event: RoomEvent): void {
  switch (event.type) {
    case 'CountdownStarted': {
      // Pick the articles while the countdown runs; the round starts when both
      // the timer and the pick have completed. Settle the selection to a plain
      // value with its handler attached NOW — a random-fetch rejection can land
      // mid-countdown, and an unhandled rejection would crash the process.
      const selection = pickPair(event.difficulty).then(
        (pair) => ({ ok: true as const, pair }),
        (err: unknown) => ({ ok: false as const, err }),
      );
      runtime.countdownTimer = setTimeout(
        () => {
          runtime.countdownTimer = null;
          void selection.then((result) => {
            if (!rooms.has(runtime.state.code)) return;
            if (result.ok) {
              dispatch(runtime, {
                kind: 'sys/countdownFinished',
                startArticle: result.pair.startArticle,
                goalArticle: result.pair.goalArticle,
                at: Date.now(),
              });
              return;
            }
            // Honest failure: no silent curated substitution. Tell the room the
            // articles couldn't be reached and abort the countdown to the lobby.
            console.warn(`pair selection failed for room ${runtime.state.code}:`, result.err);
            for (const socket of runtime.members.values()) {
              send(socket, {
                type: 'room/error',
                code: 'article-fetch-failed',
                message:
                  "Couldn't reach random Wikipedia articles — try again or switch difficulty.",
              });
            }
            dispatch(runtime, { kind: 'sys/roundStartFailed', at: Date.now() });
          });
        },
        Math.max(0, event.endsAt - Date.now()),
      );
      break;
    }
    case 'RoundStarted': {
      runtime.roundTimer = setTimeout(
        () => {
          runtime.roundTimer = null;
          dispatch(runtime, { kind: 'sys/roundTimedOut', at: Date.now() });
        },
        Math.max(0, event.deadline - Date.now()),
      );
      break;
    }
    case 'PlayerKicked': {
      // Kick is not disconnect: the socket stays connected but leaves the room.
      // Tell it it was removed and drop it from members before the broadcast so
      // the room's syncs no longer reach it.
      cancelGrace(runtime, event.playerId);
      const socket = runtime.members.get(event.playerId);
      if (socket) {
        send(socket, {
          type: 'room/error',
          code: 'kicked',
          message: 'You were removed from the room.',
        });
        runtime.members.delete(event.playerId);
        delete socket.data.roomCode;
        delete socket.data.playerId;
      }
      break;
    }
    case 'RoundEnded':
    case 'ReturnedToLobby':
    case 'CountdownAborted':
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
