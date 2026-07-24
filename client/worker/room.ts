import { DurableObject } from 'cloudflare:workers';
import { decide, initialRoom, reduce } from '@wikispeedrun/game';
import {
  MAX_NAME_LENGTH,
  normalizeRoomCode,
  type ApiErrorResponse,
  type CreateRoomResponse,
  type ErrorCode,
  type JoinRoomResponse,
} from '@wikispeedrun/shared';
import {
  closeSafely,
  parseAttachment,
  parseConnectMessage,
  rejectSocket,
  send,
  sendSync,
  trySend,
} from './roomConnection.js';
import {
  ROOM_SNAPSHOT_VERSION,
  ROOM_STORAGE_KEY,
  parseRoomSnapshot,
  type RoomSnapshot,
} from './snapshot.js';

export type CreateRoomClaim =
  ({ ok: true } & CreateRoomResponse) | { ok: false; reason: 'claimed' | 'invalid-request' };

export type JoinRoomClaim =
  | ({ ok: true } & JoinRoomResponse)
  | {
      ok: false;
      code: ErrorCode;
      message: string;
    };

type JoinTransactionResult =
  | Exclude<JoinRoomClaim, { ok: true }>
  | ({ ok: true } & JoinRoomResponse & { snapshot: RoomSnapshot });

type AuthenticationResult = { ok: false } | { ok: true; snapshot: RoomSnapshot; promoted: boolean };

export class RoomDurableObject extends DurableObject<Env> {
  async createRoom(codeInput: string, playerNameInput: string): Promise<CreateRoomClaim> {
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

    let next = room;
    for (const event of decision.events) next = reduce(next, event);
    const snapshot: RoomSnapshot = {
      schemaVersion: ROOM_SNAPSHOT_VERSION,
      room: next,
      memberships: { [playerId]: { credentialDigest } },
      joinAttempts: {},
    };

    const claimed = await this.ctx.storage.transaction(async (transaction) => {
      const existing = await transaction.get(ROOM_STORAGE_KEY);
      if (existing !== undefined) return false;
      await transaction.put(ROOM_STORAGE_KEY, snapshot);
      return true;
    });
    return claimed
      ? { ok: true, roomCode: code, playerId, rejoinCredential }
      : { ok: false, reason: 'claimed' };
  }

  async joinRoom(
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
    const result: JoinTransactionResult = await this.ctx.storage.transaction(
      async (transaction): Promise<JoinTransactionResult> => {
        const stored = await transaction.get(ROOM_STORAGE_KEY);
        if (stored === undefined) {
          return {
            ok: false,
            code: 'room-not-found',
            message: 'No room found with that code.',
          } satisfies JoinRoomClaim;
        }
        const snapshot = parseRoomSnapshot(stored);
        if (snapshot.room.code !== code) {
          return {
            ok: false,
            code: 'room-not-found',
            message: 'No room found with that code.',
          } satisfies JoinRoomClaim;
        }
        const existing = snapshot.joinAttempts[attemptId];
        if (existing?.state === 'promoted') {
          return {
            ok: false,
            code: 'invalid-request',
            message: 'This join attempt has already been completed.',
          } satisfies JoinRoomClaim;
        }
        if (existing && existing.playerName !== playerName) {
          return {
            ok: false,
            code: 'invalid-request',
            message: 'This join attempt belongs to a different Player name.',
          } satisfies JoinRoomClaim;
        }
        if (existing?.state === 'pending' && generation <= existing.generation) {
          return {
            ok: false,
            code: 'invalid-request',
            message: 'This join attempt generation is stale.',
          } satisfies JoinRoomClaim;
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

    if (!result.ok) return result;
    return {
      ok: true,
      roomCode: result.roomCode,
      playerId: result.playerId,
      rejoinCredential: result.rejoinCredential,
    };
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return roomError(426, 'invalid-request', 'Expected a WebSocket upgrade.');
    }
    const snapshot = await this.loadSnapshot();
    if (!snapshot) return roomError(404, 'room-not-found', 'No room found with that code.');

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment({ state: 'pending' });
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const attachment = parseAttachment(socket.deserializeAttachment());
    if (!attachment) {
      rejectSocket(socket, 'invalid-membership', 'Invalid connection state.', 4003);
      return;
    }
    if (attachment.state === 'authenticated') {
      send(socket, {
        type: 'room/error',
        code: 'room-unavailable',
        message: 'This Room action is not available in the current migration slice.',
      });
      return;
    }

    const connect = parseConnectMessage(raw);
    const snapshot = await this.loadSnapshot();
    if (!connect || !snapshot) {
      rejectSocket(socket, 'invalid-membership', 'The Room Membership is invalid.', 4003);
      return;
    }
    const suppliedDigest = await digestCredential(connect.rejoinCredential);
    const authentication = await this.authenticate(connect.playerId, suppliedDigest);
    if (!authentication.ok) {
      rejectSocket(socket, 'invalid-membership', 'The Room Membership is invalid.', 4003);
      return;
    }

    for (const existing of this.ctx.getWebSockets()) {
      if (existing === socket) continue;
      const existingAttachment = parseAttachment(existing.deserializeAttachment());
      if (existingAttachment?.state !== 'authenticated') continue;
      if (existingAttachment.playerId !== connect.playerId) continue;
      trySend(existing, {
        type: 'room/error',
        code: 'connection-replaced',
        message: 'This Room Membership was opened in another tab.',
      });
      closeSafely(existing, 4001, 'Connection replaced.');
    }
    socket.serializeAttachment({
      state: 'authenticated',
      playerId: connect.playerId,
    });
    if (authentication.promoted) this.broadcastSync(authentication.snapshot);
    sendSync(socket, authentication.snapshot, connect.playerId);
  }

  private broadcastSync(snapshot: RoomSnapshot): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = parseAttachment(socket.deserializeAttachment());
      if (attachment?.state !== 'authenticated') continue;
      sendSync(socket, snapshot, attachment.playerId);
    }
  }

  private async loadSnapshot(): Promise<RoomSnapshot | null> {
    const stored = await this.ctx.storage.get(ROOM_STORAGE_KEY);
    return stored === undefined ? null : parseRoomSnapshot(stored);
  }

  private async authenticate(
    playerId: string,
    suppliedDigest: string,
  ): Promise<AuthenticationResult> {
    return this.ctx.storage.transaction(async (transaction): Promise<AuthenticationResult> => {
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

function roomError(
  status: number,
  code: ApiErrorResponse['error']['code'],
  message: string,
): Response {
  return Response.json({ error: { code, message } } satisfies ApiErrorResponse, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}
