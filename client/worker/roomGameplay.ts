import { decide, reduce } from '@wikispeedrun/game';
import type { ErrorCode } from '@wikispeedrun/shared';
import type { WorkerPlayerIntent } from './roomConnection.js';
import { claimAuthenticatedMessage } from './roomRateLimit.js';
import { phaseDeadline, replacePhaseDeadline, syncAlarm } from './roomSchedule.js';
import {
  ROOM_STORAGE_KEY,
  parseRoomSnapshot,
  roundTimeoutToken,
  type RoomSnapshot,
} from './snapshot.js';

type GameplayIntent = Exclude<WorkerPlayerIntent, { type: 'game/start' | 'room/kick' }>;

export type PlayerIntentResult =
  | { kind: 'none' }
  | { kind: 'sync'; snapshot: RoomSnapshot }
  | { kind: 'error'; code: ErrorCode; message: string };

type TimeoutResult = { kind: 'none' } | { kind: 'sync'; snapshot: RoomSnapshot };

export async function processPlayerIntent(
  state: DurableObjectState,
  playerId: string,
  connectionId: string,
  intent: GameplayIntent,
): Promise<PlayerIntentResult> {
  const at = Date.now();
  return state.storage.transaction(async (transaction): Promise<PlayerIntentResult> => {
    const stored = await transaction.get(ROOM_STORAGE_KEY);
    if (stored === undefined) {
      return { kind: 'error', code: 'room-not-found', message: 'No room found with that code.' };
    }
    const claim = claimAuthenticatedMessage(parseRoomSnapshot(stored), playerId, connectionId, at);
    if (!claim.ok) return { kind: 'error', code: claim.code, message: claim.message };
    const current = claim.snapshot;
    const deadline = phaseDeadline(current.deadlines);
    if (
      current.room.phase === 'racing' &&
      deadline?.kind === 'round-timeout' &&
      at >= deadline.at
    ) {
      await transaction.put(ROOM_STORAGE_KEY, current);
      return {
        kind: 'error',
        code: 'wrong-phase',
        message: 'The round time has expired.',
      };
    }
    const decision = decide(current.room, { kind: 'client', playerId, at, intent });
    if (!decision.ok) {
      await transaction.put(ROOM_STORAGE_KEY, current);
      return { kind: 'error', code: decision.code, message: decision.message };
    }
    if (decision.events.length === 0) {
      await transaction.put(ROOM_STORAGE_KEY, current);
      return { kind: 'none' };
    }

    const room = decision.events.reduce(reduce, current.room);
    const samePhase = room.phase === current.room.phase;
    const deadlines = samePhase
      ? current.deadlines
      : room.phase === 'racing'
        ? current.deadlines
        : replacePhaseDeadline(current.deadlines, null);
    const next: RoomSnapshot = {
      ...current,
      room,
      roundPreparation: samePhase ? current.roundPreparation : null,
      deadlines,
    };
    parseRoomSnapshot(next);
    await transaction.put(ROOM_STORAGE_KEY, next);
    await syncAlarm(transaction, deadlines);
    return { kind: 'sync', snapshot: next };
  });
}

export async function finishRoundTimeout(
  state: DurableObjectState,
  snapshot: RoomSnapshot,
): Promise<TimeoutResult> {
  const deadline = phaseDeadline(snapshot.deadlines);
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
    const currentDeadline = phaseDeadline(current.deadlines);
    if (
      current.room.phase !== 'racing' ||
      !current.room.round ||
      currentDeadline?.kind !== 'round-timeout' ||
      currentDeadline.token !== deadline.token ||
      currentDeadline.at !== deadline.at
    ) {
      return { kind: 'none' };
    }
    const decision = decide(current.room, { kind: 'sys/roundTimedOut', at: Date.now() });
    if (!decision.ok || decision.events.length === 0) return { kind: 'none' };
    const deadlines = replacePhaseDeadline(current.deadlines, null);
    const next: RoomSnapshot = {
      ...current,
      room: decision.events.reduce(reduce, current.room),
      roundPreparation: null,
      deadlines,
    };
    parseRoomSnapshot(next);
    await transaction.put(ROOM_STORAGE_KEY, next);
    await syncAlarm(transaction, deadlines);
    return { kind: 'sync', snapshot: next };
  });
}
