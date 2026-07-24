import { decide, initialRoom, reduce } from '@wikispeedrun/game';
import {
  MAX_NAME_LENGTH,
  normalizeRoomCode,
  type CreateRoomResponse,
  type ErrorCode,
  type JoinRoomResponse,
} from '@wikispeedrun/shared';
import {
  ROOM_SNAPSHOT_VERSION,
  ROOM_STORAGE_KEY,
  parseRoomSnapshot,
  type RoomSnapshot,
} from './snapshot.js';

export type CreateRoomClaim =
  ({ ok: true } & CreateRoomResponse) | { ok: false; reason: 'claimed' | 'invalid-request' };

export type JoinRoomClaim =
  ({ ok: true } & JoinRoomResponse) | { ok: false; code: ErrorCode; message: string };

export type AuthenticationResult =
  { ok: false } | { ok: true; snapshot: RoomSnapshot; promoted: boolean };

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
  const decision = decide(room, {
    kind: 'client',
    playerId,
    at: Date.now(),
    intent: { type: 'room/create', playerName, playerId },
  });
  if (!decision.ok) return { ok: false, reason: 'invalid-request' };

  const snapshot: RoomSnapshot = {
    schemaVersion: ROOM_SNAPSHOT_VERSION,
    room: decision.events.reduce(reduce, room),
    memberships: { [playerId]: { credentialDigest } },
    joinAttempts: {},
    roundPreparation: null,
    deadline: null,
  };
  const claimed = await state.storage.transaction(async (transaction) => {
    const existing = await transaction.get(ROOM_STORAGE_KEY);
    if (existing !== undefined) return false;
    await transaction.put(ROOM_STORAGE_KEY, snapshot);
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
): Promise<AuthenticationResult> {
  const suppliedDigest = await digestCredential(rejoinCredential);
  return state.storage.transaction(async (transaction): Promise<AuthenticationResult> => {
    const stored = await transaction.get(ROOM_STORAGE_KEY);
    if (stored === undefined) return { ok: false };
    const snapshot = parseRoomSnapshot(stored);
    const membership = snapshot.memberships[playerId];
    if (membership?.credentialDigest === suppliedDigest) {
      return { ok: true, snapshot, promoted: false };
    }

    const pendingEntry = Object.entries(snapshot.joinAttempts).find(
      ([, attempt]) =>
        attempt.state === 'pending' &&
        attempt.playerId === playerId &&
        attempt.credentialDigest === suppliedDigest,
    );
    if (!pendingEntry) return { ok: false };
    const [attemptId, pending] = pendingEntry;
    if (pending.state !== 'pending') return { ok: false };
    const decision = decide(snapshot.room, {
      kind: 'client',
      playerId,
      at: Date.now(),
      intent: {
        type: 'room/join',
        code: snapshot.room.code,
        playerName: pending.playerName,
        playerId,
      },
    });
    if (!decision.ok) return { ok: false };
    const next: RoomSnapshot = {
      ...snapshot,
      room: decision.events.reduce(reduce, snapshot.room),
      memberships: {
        ...snapshot.memberships,
        [playerId]: { credentialDigest: pending.credentialDigest },
      },
      joinAttempts: {
        ...snapshot.joinAttempts,
        [attemptId]: { state: 'promoted', playerId },
      },
    };
    await transaction.put(ROOM_STORAGE_KEY, next);
    return { ok: true, snapshot: next, promoted: true };
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
