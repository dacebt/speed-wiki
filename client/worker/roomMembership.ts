import { decide, initialRoom, reduce } from '@wikispeedrun/game';
import {
  MAX_NAME_LENGTH,
  ROOM_MEMBERSHIP_LIMIT,
  normalizeRoomCode,
  type CreateRoomResponse,
  type ErrorCode,
  type JoinRoomResponse,
} from '@wikispeedrun/shared';
import { advanceMessageWindow, initialMessageWindow } from './roomRateLimit.js';
import {
  ROOM_SNAPSHOT_VERSION,
  ROOM_STORAGE_KEY,
  parseRoomSnapshot,
  type RoomSnapshot,
} from './snapshot.js';
import { MEMBERSHIP_GRACE_MS, removeMembershipGrace, syncAlarm } from './roomSchedule.js';

export type CreateRoomClaim =
  ({ ok: true } & CreateRoomResponse) | { ok: false; reason: 'claimed' | 'invalid-request' };

export type JoinRoomClaim =
  ({ ok: true } & JoinRoomResponse) | { ok: false; code: ErrorCode; message: string };

export type AuthenticationResult =
  | { ok: false; reason: 'invalid-membership' | 'rate-limited' }
  | {
      ok: true;
      snapshot: RoomSnapshot;
      promoted: boolean;
      previousConnectionId: string | null;
    };

type JoinTransactionResult =
  | Exclude<JoinRoomClaim, { ok: true }>
  | ({ ok: true } & JoinRoomResponse & { snapshot: RoomSnapshot });
type JoinFailure = Exclude<JoinRoomClaim, { ok: true }>;

export async function createRoomClaim(
  state: DurableObjectState,
  codeInput: string,
  playerNameInput: string,
): Promise<CreateRoomClaim> {
  const code = normalizeRoomCode(codeInput);
  const playerName = playerNameInput.trim();
  if (!code || playerName.length === 0 || playerName.length > MAX_NAME_LENGTH) {
    return { ok: false, reason: 'invalid-request' };
  }

  const playerId = crypto.randomUUID();
  const rejoinCredential = randomCredential();
  const credentialDigest = await digestCredential(rejoinCredential);
  const room = initialRoom(code);
  const at = Date.now();
  const decision = decide(room, {
    kind: 'client',
    playerId,
    at,
    intent: { type: 'room/create', playerName, playerId },
  });
  if (!decision.ok) return { ok: false, reason: 'invalid-request' };
  const joined = decision.events.reduce(reduce, room);
  const away = decide(joined, { kind: 'sys/playerAway', playerId, at });
  if (!away.ok) return { ok: false, reason: 'invalid-request' };
  const graceAt = at + MEMBERSHIP_GRACE_MS;

  const snapshot: RoomSnapshot = {
    schemaVersion: ROOM_SNAPSHOT_VERSION,
    room: away.events.reduce(reduce, joined),
    memberships: {
      [playerId]: {
        credentialDigest,
        activeConnectionId: null,
        messageWindow: initialMessageWindow(),
      },
    },
    joinAttempts: {},
    roundPreparation: null,
    deadlines: [{ kind: 'membership-grace', playerId, connectionId: null, at: graceAt }],
  };
  parseRoomSnapshot(snapshot);
  const claimed = await state.storage.transaction(async (transaction) => {
    const existing = await transaction.get(ROOM_STORAGE_KEY);
    if (existing !== undefined) return false;
    await transaction.put(ROOM_STORAGE_KEY, snapshot);
    await syncAlarm(transaction, snapshot.deadlines);
    return true;
  });
  return claimed
    ? { ok: true, roomCode: code, playerId, rejoinCredential }
    : { ok: false, reason: 'claimed' };
}

export async function joinRoomClaim(
  state: DurableObjectState,
  codeInput: string,
  playerNameInput: string,
  attemptId: string,
  generation: number,
): Promise<JoinRoomClaim> {
  const code = normalizeRoomCode(codeInput);
  const playerName = playerNameInput.trim();
  if (!code || playerName.length === 0 || playerName.length > MAX_NAME_LENGTH) {
    return { ok: false, code: 'invalid-name', message: 'The Player name is invalid.' };
  }

  const rejoinCredential = randomCredential();
  const credentialDigest = await digestCredential(rejoinCredential);
  const result: JoinTransactionResult = await state.storage.transaction(
    async (transaction): Promise<JoinTransactionResult> => {
      const stored = await transaction.get(ROOM_STORAGE_KEY);
      if (stored === undefined) return roomNotFound();
      const snapshot = parseRoomSnapshot(stored);
      if (snapshot.room.code !== code) return roomNotFound();
      const existing = snapshot.joinAttempts[attemptId];
      if (existing?.state === 'promoted') {
        return reject('invalid-request', 'This join attempt has already been completed.');
      }
      if (existing && existing.playerName !== playerName) {
        return reject('invalid-request', 'This join attempt belongs to a different Player name.');
      }
      if (existing?.state === 'pending' && generation <= existing.generation) {
        return reject('invalid-request', 'This join attempt generation is stale.');
      }
      if (!existing) {
        const pendingCount = Object.values(snapshot.joinAttempts).filter(
          (attempt) => attempt.state === 'pending',
        ).length;
        if (Object.keys(snapshot.memberships).length + pendingCount >= ROOM_MEMBERSHIP_LIMIT) {
          return reject('room-full', 'The Room is full.');
        }
      }
      const playerId = existing?.playerId ?? crypto.randomUUID();
      const next: RoomSnapshot = {
        ...snapshot,
        joinAttempts: {
          ...snapshot.joinAttempts,
          [attemptId]: {
            state: 'pending',
            playerId,
            playerName,
            credentialDigest,
            generation,
          },
        },
      };
      await transaction.put(ROOM_STORAGE_KEY, next);
      return {
        ok: true,
        roomCode: code,
        playerId,
        rejoinCredential,
        snapshot: next,
      };
    },
  );
  return result.ok
    ? {
        ok: true,
        roomCode: result.roomCode,
        playerId: result.playerId,
        rejoinCredential: result.rejoinCredential,
      }
    : result;
}

export async function authenticateMembership(
  state: DurableObjectState,
  playerId: string,
  rejoinCredential: string,
  connectionId: string,
): Promise<AuthenticationResult> {
  const suppliedDigest = await digestCredential(rejoinCredential);
  return state.storage.transaction(async (transaction): Promise<AuthenticationResult> => {
    const stored = await transaction.get(ROOM_STORAGE_KEY);
    if (stored === undefined) return { ok: false, reason: 'invalid-membership' };
    const snapshot = parseRoomSnapshot(stored);
    const membership = snapshot.memberships[playerId];
    if (membership?.credentialDigest === suppliedDigest) {
      const at = Date.now();
      if (membership.activeConnectionId === null) {
        const grace = snapshot.deadlines.find(
          (deadline) => deadline.kind === 'membership-grace' && deadline.playerId === playerId,
        );
        if (!grace || at >= grace.at) return { ok: false, reason: 'invalid-membership' };
      }
      const messageWindow = advanceMessageWindow(membership.messageWindow, at);
      if (!messageWindow) return { ok: false, reason: 'rate-limited' };
      const decision = decide(snapshot.room, {
        kind: 'client',
        playerId,
        at,
        intent: {
          type: 'room/join',
          code: snapshot.room.code,
          playerName: snapshot.room.players.find((player) => player.id === playerId)?.name ?? '',
          playerId,
        },
      });
      if (!decision.ok) return { ok: false, reason: 'invalid-membership' };
      const next: RoomSnapshot = {
        ...snapshot,
        room: decision.events.reduce(reduce, snapshot.room),
        memberships: {
          ...snapshot.memberships,
          [playerId]: { ...membership, activeConnectionId: connectionId, messageWindow },
        },
        deadlines: removeMembershipGrace(snapshot.deadlines, playerId),
      };
      parseRoomSnapshot(next);
      await transaction.put(ROOM_STORAGE_KEY, next);
      await syncAlarm(transaction, next.deadlines);
      return {
        ok: true,
        snapshot: next,
        promoted: false,
        previousConnectionId: membership.activeConnectionId,
      };
    }

    const pendingEntry = Object.entries(snapshot.joinAttempts).find(
      ([, attempt]) =>
        attempt.state === 'pending' &&
        attempt.playerId === playerId &&
        attempt.credentialDigest === suppliedDigest,
    );
    if (!pendingEntry) return { ok: false, reason: 'invalid-membership' };
    if (
      snapshot.deadlines.some(
        (deadline) => deadline.kind === 'membership-grace' && deadline.connectionId === null,
      )
    ) {
      return { ok: false, reason: 'invalid-membership' };
    }
    const [attemptId, pending] = pendingEntry;
    if (pending.state !== 'pending') return { ok: false, reason: 'invalid-membership' };
    const at = Date.now();
    const decision = decide(snapshot.room, {
      kind: 'client',
      playerId,
      at,
      intent: {
        type: 'room/join',
        code: snapshot.room.code,
        playerName: pending.playerName,
        playerId,
      },
    });
    if (!decision.ok) return { ok: false, reason: 'invalid-membership' };
    const next: RoomSnapshot = {
      ...snapshot,
      room: decision.events.reduce(reduce, snapshot.room),
      memberships: {
        ...snapshot.memberships,
        [playerId]: {
          credentialDigest: pending.credentialDigest,
          activeConnectionId: connectionId,
          messageWindow: { startedAt: at, count: 1 },
        },
      },
      joinAttempts: {
        ...snapshot.joinAttempts,
        [attemptId]: { state: 'promoted', playerId },
      },
      deadlines: removeMembershipGrace(snapshot.deadlines, playerId),
    };
    parseRoomSnapshot(next);
    await transaction.put(ROOM_STORAGE_KEY, next);
    await syncAlarm(transaction, next.deadlines);
    return {
      ok: true,
      snapshot: next,
      promoted: true,
      previousConnectionId: null,
    };
  });
}

function roomNotFound(): JoinFailure {
  return reject('room-not-found', 'No room found with that code.');
}

function reject(code: ErrorCode, message: string): JoinFailure {
  return { ok: false, code, message };
}

function randomCredential(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function digestCredential(credential: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(credential));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
