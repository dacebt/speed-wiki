import { DurableObject } from 'cloudflare:workers';
import { type ApiErrorResponse, type ErrorCode } from '@wikispeedrun/shared';
import {
  closeSafely,
  parseAttachment,
  parseAuthenticatedMessage,
  parseConnectMessage,
  rejectSocket,
  send,
  sendSync,
  trySend,
} from './roomConnection.js';
import { ROOM_STORAGE_KEY, parseRoomSnapshot, type RoomSnapshot } from './snapshot.js';
import { processRoomAlarm, startRoundPreparation } from './roomLifecycle.js';
import {
  authenticateMembership,
  createRoomClaim,
  joinRoomClaim,
  type CreateRoomClaim,
  type JoinRoomClaim,
} from './roomMembership.js';

export class RoomDurableObject extends DurableObject<Env> {
  async createRoom(codeInput: string, playerNameInput: string): Promise<CreateRoomClaim> {
    return createRoomClaim(this.ctx, codeInput, playerNameInput);
  }

  async joinRoom(
    codeInput: string,
    playerNameInput: string,
    attemptId: string,
    generation: number,
  ): Promise<JoinRoomClaim> {
    return joinRoomClaim(this.ctx, codeInput, playerNameInput, attemptId, generation);
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
      const message = parseAuthenticatedMessage(raw);
      if (message === 'invalid') {
        send(socket, {
          type: 'room/error',
          code: 'invalid-request',
          message: 'The Room action is invalid.',
        });
      } else if (message === 'unsupported') {
        send(socket, {
          type: 'room/error',
          code: 'room-unavailable',
          message: 'This Room action is not available in the current migration slice.',
        });
      } else {
        await this.startRoundPreparation(socket, attachment.playerId);
      }
      return;
    }

    const connect = parseConnectMessage(raw);
    const snapshot = await this.loadSnapshot();
    if (!connect || !snapshot) {
      rejectSocket(socket, 'invalid-membership', 'The Room Membership is invalid.', 4003);
      return;
    }
    const authentication = await authenticateMembership(
      this.ctx,
      connect.playerId,
      connect.rejoinCredential,
    );
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

  override async alarm(): Promise<void> {
    const result = await processRoomAlarm(this.ctx);
    if (result.kind === 'error') {
      this.broadcastError(result.code, result.message);
      this.broadcastSync(result.snapshot);
    } else if (result.kind === 'sync') {
      this.broadcastSync(result.snapshot);
    }
  }

  private async startRoundPreparation(socket: WebSocket, playerId: string): Promise<void> {
    const result = await startRoundPreparation(this.ctx, playerId);
    if (result.kind === 'error') {
      send(socket, { type: 'room/error', code: result.code, message: result.message });
    } else {
      this.broadcastSync(result.snapshot);
    }
  }

  private broadcastSync(snapshot: RoomSnapshot): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = parseAttachment(socket.deserializeAttachment());
      if (attachment?.state !== 'authenticated') continue;
      sendSync(socket, snapshot, attachment.playerId);
    }
  }

  private broadcastError(code: ErrorCode, message: string): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = parseAttachment(socket.deserializeAttachment());
      if (attachment?.state !== 'authenticated') continue;
      trySend(socket, { type: 'room/error', code, message });
    }
  }

  private async loadSnapshot(): Promise<RoomSnapshot | null> {
    const stored = await this.ctx.storage.get(ROOM_STORAGE_KEY);
    return stored === undefined ? null : parseRoomSnapshot(stored);
  }
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
