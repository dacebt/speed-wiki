import { decide, reduce } from '@wikispeedrun/game';
import type { ErrorCode } from '@wikispeedrun/shared';
import type { WorkerPlayerIntent } from './roomConnection.js';
import {
  ROOM_STORAGE_KEY,
  parseRoomSnapshot,
  roundTimeoutToken,
  type RoomSnapshot,
} from './snapshot.js';

type GameplayIntent = Exclude<WorkerPlayerIntent, { type: 'game/start' }>;

export type PlayerIntentResult =
  | { kind: 'none' }
  | { kind: 'sync'; snapshot: RoomSnapshot }
  | { kind: 'error'; code: ErrorCode; message: string };

type TimeoutResult = { kind: 'none' } | { kind: 'sync'; snapshot: RoomSnapshot };

export async function processPlayerIntent(
  state: DurableObjectState,
  playerId: string,
  intent: GameplayIntent,
): Promise<PlayerIntentResult> {
  const at = Date.now();
  return state.storage.transaction(async (transaction): Promise<PlayerIntentResult> => {
    const stored = await transaction.get(ROOM_STORAGE_KEY);
    if (stored === undefined) {
      return { kind: 'error', code: 'room-not-found', message: 'No room found with that code.' };
    }
    const current = parseRoomSnapshot(stored);
    if (
      current.room.phase === 'racing' &&
      current.deadline?.kind === 'round-timeout' &&
      at >= current.deadline.at
    ) {
      return {
        kind: 'error',
        code: 'wrong-phase',
        message: 'The round time has expired.',
      };
    }
    const decision = decide(current.room, { kind: 'client', playerId, at, intent });
    if (!decision.ok) {
      return { kind: 'error', code: decision.code, message: decision.message };
    }
    if (decision.events.length === 0) return { kind: 'none' };

    const room = decision.events.reduce(reduce, current.room);
    const next: RoomSnapshot = {
      ...current,
      room,
      roundPreparation: null,
      deadline: room.phase === 'racing' ? current.deadline : null,
    };
    parseRoomSnapshot(next);
    await transaction.put(ROOM_STORAGE_KEY, next);
    if (room.phase !== 'racing') await transaction.deleteAlarm();
    return { kind: 'sync', snapshot: next };
  });
}

export async function finishRoundTimeout(
  state: DurableObjectState,
  snapshot: RoomSnapshot,
): Promise<TimeoutResult> {
  const deadline = snapshot.deadline;
  if (
    snapshot.room.phase !== 'racing' ||
    !snapshot.room.round ||
    deadline?.kind !== 'round-timeout' ||
    deadline.token !== roundTimeoutToken(snapshot.room.round) ||
    deadline.at !== snapshot.room.round.deadline
  ) {
    return { kind: 'none' };
  }

  return state.storage.transaction(async (transaction): Promise<TimeoutResult> => {
    const stored = await transaction.get(ROOM_STORAGE_KEY);
    if (stored === undefined) return { kind: 'none' };
    const current = parseRoomSnapshot(stored);
    if (
      current.room.phase !== 'racing' ||
      !current.room.round ||
      current.deadline?.kind !== 'round-timeout' ||
      current.deadline.token !== deadline.token ||
      current.deadline.at !== deadline.at
    ) {
      return { kind: 'none' };
    }
    const decision = decide(current.room, { kind: 'sys/roundTimedOut', at: Date.now() });
    if (!decision.ok || decision.events.length === 0) return { kind: 'none' };
    const next: RoomSnapshot = {
      ...current,
      room: decision.events.reduce(reduce, current.room),
      roundPreparation: null,
      deadline: null,
    };
    parseRoomSnapshot(next);
    await transaction.put(ROOM_STORAGE_KEY, next);
    await transaction.deleteAlarm();
    return { kind: 'sync', snapshot: next };
  });
}
