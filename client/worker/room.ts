import { DurableObject } from 'cloudflare:workers';
import { decide, initialRoom, reduce, toRoomSync } from '@wikispeedrun/game';
import {
  MAX_NAME_LENGTH,
  normalizeRoomCode,
  type ApiErrorResponse,
  type CreateRoomResponse,
  type RoomConnectMessage,
  type ServerMessage,
} from '@wikispeedrun/shared';
import {
  ROOM_SNAPSHOT_VERSION,
  ROOM_STORAGE_KEY,
  parseRoomSnapshot,
  type RoomSnapshot,
} from './snapshot.js';

type PendingAttachment = { state: 'pending' };
type AuthenticatedAttachment = { state: 'authenticated'; playerId: string };
type ConnectionAttachment = PendingAttachment | AuthenticatedAttachment;

export type CreateRoomClaim =
  ({ ok: true } & CreateRoomResponse) | { ok: false; reason: 'claimed' | 'invalid-request' };

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

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return roomError(426, 'invalid-request', 'Expected a WebSocket upgrade.');
    }
    const snapshot = await this.loadSnapshot();
    if (!snapshot) return roomError(404, 'room-not-found', 'No room found with that code.');

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment({ state: 'pending' } satisfies PendingAttachment);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const attachment = parseAttachment(socket.deserializeAttachment());
    if (!attachment) {
      socket.close(1011, 'Invalid connection state.');
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
      socket.close(1008, 'Invalid Membership.');
      return;
    }
    const membership = snapshot.memberships[connect.playerId];
    const suppliedDigest = await digestCredential(connect.rejoinCredential);
    if (!membership || membership.credentialDigest !== suppliedDigest) {
      socket.close(1008, 'Invalid Membership.');
      return;
    }

    socket.serializeAttachment({
      state: 'authenticated',
      playerId: connect.playerId,
    } satisfies AuthenticatedAttachment);
    send(socket, {
      type: 'room/sync',
      room: toRoomSync(snapshot.room),
      you: connect.playerId,
      at: Date.now(),
    });
  }

  private async loadSnapshot(): Promise<RoomSnapshot | null> {
    const stored = await this.ctx.storage.get(ROOM_STORAGE_KEY);
    return stored === undefined ? null : parseRoomSnapshot(stored);
  }
}

function parseAttachment(value: unknown): ConnectionAttachment | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.state === 'pending') return { state: 'pending' };
  return record.state === 'authenticated' && typeof record.playerId === 'string'
    ? { state: 'authenticated', playerId: record.playerId }
    : null;
}

function parseConnectMessage(raw: string | ArrayBuffer): RoomConnectMessage | null {
  if (typeof raw !== 'string') return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    return record.type === 'room/connect' &&
      typeof record.playerId === 'string' &&
      typeof record.rejoinCredential === 'string'
      ? {
          type: 'room/connect',
          playerId: record.playerId,
          rejoinCredential: record.rejoinCredential,
        }
      : null;
  } catch {
    return null;
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

function send(socket: WebSocket, message: ServerMessage): void {
  socket.send(JSON.stringify(message));
}

function roomError(
  status: number,
  code: ApiErrorResponse['error']['code'],
  message: string,
): Response {
  return Response.json({ error: { code, message } } satisfies ApiErrorResponse, { status });
}
