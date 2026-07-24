import { decide, reduce } from '@wikispeedrun/game';
import type { ErrorCode } from '@wikispeedrun/shared';
import {
  ROOM_STORAGE_KEY,
  parseRoomSnapshot,
  roundTimeoutToken,
  type RoomSnapshot,
} from './snapshot.js';
import { nextDeadline, phaseDeadline, replacePhaseDeadline, syncAlarm } from './roomSchedule.js';
import { finishRoundTimeout } from './roomGameplay.js';
import { expireMembershipGrace } from './roomPresence.js';
import { pickPair } from './wikipedia.js';

const PREPARATION_ALARM_DELAY_MS = 500;
const ARTICLE_FETCH_FAILURE =
  "Couldn't reach random Wikipedia articles — try again or switch difficulty.";

export type StartPreparationResult =
  { kind: 'sync'; snapshot: RoomSnapshot } | { kind: 'error'; code: ErrorCode; message: string };

export type AlarmResult =
  | { kind: 'none' }
  | { kind: 'deleted' }
  | { kind: 'sync'; snapshot: RoomSnapshot }
  | { kind: 'error'; code: ErrorCode; message: string; snapshot: RoomSnapshot };

export async function startRoundPreparation(
  state: DurableObjectState,
  playerId: string,
  connectionId: string,
): Promise<StartPreparationResult> {
  const at = Date.now();
  const alarmAt = at + PREPARATION_ALARM_DELAY_MS;
  return state.storage.transaction(async (transaction): Promise<StartPreparationResult> => {
    const stored = await transaction.get(ROOM_STORAGE_KEY);
    if (stored === undefined) {
      return { kind: 'error', code: 'room-not-found', message: 'No room found with that code.' };
    }
    const currentSnapshot = parseRoomSnapshot(stored);
    const membership = currentSnapshot.memberships[playerId];
    if (!membership) {
      return {
        kind: 'error',
        code: 'invalid-membership',
        message: 'The Room Membership is invalid.',
      };
    }
    if (membership.activeConnectionId !== connectionId) {
      return {
        kind: 'error',
        code: 'connection-replaced',
        message: 'This Room Membership was opened in another tab.',
      };
    }
    const decision = decide(currentSnapshot.room, {
      kind: 'client',
      playerId,
      at,
      intent: { type: 'game/start' },
    });
    if (!decision.ok) {
      return { kind: 'error', code: decision.code, message: decision.message };
    }
    const token = crypto.randomUUID();
    const deadlines = replacePhaseDeadline(currentSnapshot.deadlines, {
      kind: 'round-preparation',
      token,
      at: alarmAt,
    });
    const next: RoomSnapshot = {
      ...currentSnapshot,
      room: decision.events.reduce(reduce, currentSnapshot.room),
      roundPreparation: {
        token,
        difficulty: currentSnapshot.room.settings.difficulty,
        category: currentSnapshot.room.settings.category,
        pair: null,
      },
      deadlines,
    };
    parseRoomSnapshot(next);
    await transaction.put(ROOM_STORAGE_KEY, next);
    await syncAlarm(transaction, deadlines);
    return { kind: 'sync', snapshot: next };
  });
}

export async function processRoomAlarm(state: DurableObjectState): Promise<AlarmResult> {
  const snapshot = await loadSnapshot(state);
  if (!snapshot) return { kind: 'none' };
  const deadline = nextDeadline(snapshot.deadlines);
  if (!deadline) return { kind: 'none' };
  if (Date.now() < deadline.at) {
    await syncAlarm(state.storage, snapshot.deadlines);
    return { kind: 'none' };
  }
  switch (deadline.kind) {
    case 'membership-grace':
      return expireMembershipGrace(state, deadline);
    case 'round-preparation':
      return prepareRound(state, snapshot);
    case 'countdown':
      return finishCountdown(state, snapshot);
    case 'round-timeout':
      return finishRoundTimeout(state, snapshot);
  }
}

async function prepareRound(
  state: DurableObjectState,
  snapshot: RoomSnapshot,
): Promise<AlarmResult> {
  const preparation = snapshot.roundPreparation;
  const deadline = phaseDeadline(snapshot.deadlines);
  if (
    snapshot.room.phase !== 'preparing' ||
    !preparation ||
    preparation.pair !== null ||
    deadline?.kind !== 'round-preparation' ||
    deadline.token !== preparation.token
  ) {
    return { kind: 'none' };
  }

  let pair: Awaited<ReturnType<typeof pickPair>>;
  try {
    pair = await pickPair(preparation.difficulty, preparation.category);
  } catch {
    const failed = await abortPreparation(state, preparation.token);
    return failed
      ? {
          kind: 'error',
          code: 'article-fetch-failed',
          message: ARTICLE_FETCH_FAILURE,
          snapshot: failed,
        }
      : { kind: 'none' };
  }

  const selected = await state.storage.transaction(async (transaction) => {
    const stored = await transaction.get(ROOM_STORAGE_KEY);
    if (stored === undefined) return null;
    const current = parseRoomSnapshot(stored);
    const currentDeadline = phaseDeadline(current.deadlines);
    if (
      current.room.phase !== 'preparing' ||
      current.roundPreparation?.token !== preparation.token ||
      current.roundPreparation.pair !== null ||
      currentDeadline?.kind !== 'round-preparation' ||
      currentDeadline.token !== preparation.token
    ) {
      return null;
    }
    const decision = decide(current.room, {
      kind: 'sys/roundPrepared',
      startArticle: pair.startArticle,
      goalArticle: pair.goalArticle,
      at: Date.now(),
    });
    if (!decision.ok || decision.events.length === 0) return null;
    const room = decision.events.reduce(reduce, current.room);
    if (room.countdownEndsAt === null) return null;
    const deadlines = replacePhaseDeadline(current.deadlines, {
      kind: 'countdown',
      token: preparation.token,
      at: room.countdownEndsAt,
    });
    const next: RoomSnapshot = {
      ...current,
      room,
      roundPreparation: { ...current.roundPreparation, pair },
      deadlines,
    };
    parseRoomSnapshot(next);
    await transaction.put(ROOM_STORAGE_KEY, next);
    await syncAlarm(transaction, deadlines);
    return next;
  });
  return selected ? { kind: 'sync', snapshot: selected } : { kind: 'none' };
}

async function abortPreparation(
  state: DurableObjectState,
  token: string,
): Promise<RoomSnapshot | null> {
  return state.storage.transaction(async (transaction) => {
    const stored = await transaction.get(ROOM_STORAGE_KEY);
    if (stored === undefined) return null;
    const current = parseRoomSnapshot(stored);
    const deadline = phaseDeadline(current.deadlines);
    if (
      current.room.phase !== 'preparing' ||
      current.roundPreparation?.token !== token ||
      deadline?.kind !== 'round-preparation' ||
      deadline.token !== token
    ) {
      return null;
    }
    const decision = decide(current.room, { kind: 'sys/roundStartFailed', at: Date.now() });
    if (!decision.ok || decision.events.length === 0) return null;
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
    return next;
  });
}

async function finishCountdown(
  state: DurableObjectState,
  snapshot: RoomSnapshot,
): Promise<AlarmResult> {
  const preparation = snapshot.roundPreparation;
  const deadline = phaseDeadline(snapshot.deadlines);
  if (
    snapshot.room.phase !== 'countdown' ||
    !preparation?.pair ||
    deadline?.kind !== 'countdown' ||
    deadline.token !== preparation.token
  ) {
    return { kind: 'none' };
  }
  const started = await state.storage.transaction(async (transaction) => {
    const stored = await transaction.get(ROOM_STORAGE_KEY);
    if (stored === undefined) return null;
    const current = parseRoomSnapshot(stored);
    const currentDeadline = phaseDeadline(current.deadlines);
    if (
      current.room.phase !== 'countdown' ||
      current.roundPreparation?.token !== preparation.token ||
      !current.roundPreparation.pair ||
      currentDeadline?.kind !== 'countdown' ||
      currentDeadline.token !== preparation.token
    ) {
      return null;
    }
    const pair = current.roundPreparation.pair;
    const decision = decide(current.room, {
      kind: 'sys/countdownFinished',
      startArticle: pair.startArticle,
      goalArticle: pair.goalArticle,
      at: Date.now(),
    });
    if (!decision.ok || decision.events.length === 0) return null;
    const room = decision.events.reduce(reduce, current.room);
    if (!room.round) return null;
    const deadlines = replacePhaseDeadline(current.deadlines, {
      kind: 'round-timeout',
      token: roundTimeoutToken(room.round),
      at: room.round.deadline,
    });
    const next: RoomSnapshot = {
      ...current,
      room,
      roundPreparation: null,
      deadlines,
    };
    parseRoomSnapshot(next);
    await transaction.put(ROOM_STORAGE_KEY, next);
    await syncAlarm(transaction, deadlines);
    return next;
  });
  return started ? { kind: 'sync', snapshot: started } : { kind: 'none' };
}

async function loadSnapshot(state: DurableObjectState): Promise<RoomSnapshot | null> {
  const stored = await state.storage.get(ROOM_STORAGE_KEY);
  return stored === undefined ? null : parseRoomSnapshot(stored);
}
