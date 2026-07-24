import { decide, reduce } from '@wikispeedrun/game';
import type { ErrorCode } from '@wikispeedrun/shared';
import { ROOM_STORAGE_KEY, parseRoomSnapshot, type RoomSnapshot } from './snapshot.js';
import { pickPair } from './wikipedia.js';

const PREPARATION_ALARM_DELAY_MS = 500;
const ARTICLE_FETCH_FAILURE =
  "Couldn't reach random Wikipedia articles — try again or switch difficulty.";

export type StartPreparationResult =
  { kind: 'sync'; snapshot: RoomSnapshot } | { kind: 'error'; code: ErrorCode; message: string };

export type AlarmResult =
  | { kind: 'none' }
  | { kind: 'sync'; snapshot: RoomSnapshot }
  | { kind: 'error'; code: ErrorCode; message: string; snapshot: RoomSnapshot };

export async function startRoundPreparation(
  state: DurableObjectState,
  playerId: string,
): Promise<StartPreparationResult> {
  const at = Date.now();
  const current = await loadSnapshot(state);
  if (!current) {
    return { kind: 'error', code: 'room-not-found', message: 'No room found with that code.' };
  }
  const authorization = decide(current.room, {
    kind: 'client',
    playerId,
    at,
    intent: { type: 'game/start' },
  });
  if (!authorization.ok) {
    return { kind: 'error', code: authorization.code, message: authorization.message };
  }

  const alarmAt = at + PREPARATION_ALARM_DELAY_MS;
  const snapshot = await state.storage.transaction(async (transaction) => {
    const stored = await transaction.get(ROOM_STORAGE_KEY);
    if (stored === undefined) return null;
    const currentSnapshot = parseRoomSnapshot(stored);
    const decision = decide(currentSnapshot.room, {
      kind: 'client',
      playerId,
      at,
      intent: { type: 'game/start' },
    });
    if (!decision.ok) return null;
    const token = crypto.randomUUID();
    const next: RoomSnapshot = {
      ...currentSnapshot,
      room: decision.events.reduce(reduce, currentSnapshot.room),
      roundPreparation: {
        token,
        difficulty: currentSnapshot.room.settings.difficulty,
        category: currentSnapshot.room.settings.category,
        pair: null,
      },
      deadline: { kind: 'round-preparation', token, at: alarmAt },
    };
    parseRoomSnapshot(next);
    await transaction.put(ROOM_STORAGE_KEY, next);
    await transaction.setAlarm(alarmAt);
    return next;
  });
  return snapshot
    ? { kind: 'sync', snapshot }
    : {
        kind: 'error',
        code: 'wrong-phase',
        message: 'The Room changed before the race could start.',
      };
}

export async function processRoomAlarm(state: DurableObjectState): Promise<AlarmResult> {
  const snapshot = await loadSnapshot(state);
  if (!snapshot?.deadline) return { kind: 'none' };
  if (Date.now() < snapshot.deadline.at) {
    await state.storage.setAlarm(snapshot.deadline.at);
    return { kind: 'none' };
  }
  return snapshot.deadline.kind === 'round-preparation'
    ? prepareRound(state, snapshot)
    : finishCountdown(state, snapshot);
}

async function prepareRound(
  state: DurableObjectState,
  snapshot: RoomSnapshot,
): Promise<AlarmResult> {
  const preparation = snapshot.roundPreparation;
  if (
    snapshot.room.phase !== 'preparing' ||
    !preparation ||
    preparation.pair !== null ||
    snapshot.deadline?.kind !== 'round-preparation' ||
    snapshot.deadline.token !== preparation.token
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
    if (
      current.room.phase !== 'preparing' ||
      current.roundPreparation?.token !== preparation.token ||
      current.roundPreparation.pair !== null ||
      current.deadline?.kind !== 'round-preparation' ||
      current.deadline.token !== preparation.token
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
    const next: RoomSnapshot = {
      ...current,
      room,
      roundPreparation: { ...current.roundPreparation, pair },
      deadline: { kind: 'countdown', token: preparation.token, at: room.countdownEndsAt },
    };
    parseRoomSnapshot(next);
    await transaction.put(ROOM_STORAGE_KEY, next);
    await transaction.setAlarm(room.countdownEndsAt);
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
    if (
      current.room.phase !== 'preparing' ||
      current.roundPreparation?.token !== token ||
      current.deadline?.kind !== 'round-preparation' ||
      current.deadline.token !== token
    ) {
      return null;
    }
    const decision = decide(current.room, { kind: 'sys/roundStartFailed', at: Date.now() });
    if (!decision.ok || decision.events.length === 0) return null;
    const next: RoomSnapshot = {
      ...current,
      room: decision.events.reduce(reduce, current.room),
      roundPreparation: null,
      deadline: null,
    };
    parseRoomSnapshot(next);
    await transaction.put(ROOM_STORAGE_KEY, next);
    await transaction.deleteAlarm();
    return next;
  });
}

async function finishCountdown(
  state: DurableObjectState,
  snapshot: RoomSnapshot,
): Promise<AlarmResult> {
  const preparation = snapshot.roundPreparation;
  if (
    snapshot.room.phase !== 'countdown' ||
    !preparation?.pair ||
    snapshot.deadline?.kind !== 'countdown' ||
    snapshot.deadline.token !== preparation.token
  ) {
    return { kind: 'none' };
  }
  const started = await state.storage.transaction(async (transaction) => {
    const stored = await transaction.get(ROOM_STORAGE_KEY);
    if (stored === undefined) return null;
    const current = parseRoomSnapshot(stored);
    if (
      current.room.phase !== 'countdown' ||
      current.roundPreparation?.token !== preparation.token ||
      !current.roundPreparation.pair ||
      current.deadline?.kind !== 'countdown' ||
      current.deadline.token !== preparation.token
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
    const next: RoomSnapshot = {
      ...current,
      room: decision.events.reduce(reduce, current.room),
      roundPreparation: null,
      deadline: null,
    };
    parseRoomSnapshot(next);
    await transaction.put(ROOM_STORAGE_KEY, next);
    await transaction.deleteAlarm();
    return next;
  });
  return started ? { kind: 'sync', snapshot: started } : { kind: 'none' };
}

async function loadSnapshot(state: DurableObjectState): Promise<RoomSnapshot | null> {
  const stored = await state.storage.get(ROOM_STORAGE_KEY);
  return stored === undefined ? null : parseRoomSnapshot(stored);
}
