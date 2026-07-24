import { DurableObject } from 'cloudflare:workers';
import { type ApiErrorResponse, type ErrorCode } from '@wikispeedrun/shared';
import {
  closeSafely,
  isMessageWithinByteLimit,
  parseAttachment,
  parseAuthenticatedMessage,
  parseConnectMessage,
  rejectSocket,
  send,
  sendSync,
  trySend,
  type WorkerPlayerIntent,
} from './roomConnection.js';
import { processPlayerIntent } from './roomGameplay.js';
import { disconnectMembership, kickMembership } from './roomPresence.js';
import { ROOM_STORAGE_KEY, parseRoomSnapshot, type RoomSnapshot } from './snapshot.js';
import { processRoomAlarm, startRoundPreparation } from './roomLifecycle.js';
import { consumeAuthenticatedMessage } from './roomRateLimit.js';
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
    if (!isMessageWithinByteLimit(raw)) {
      rejectSocket(
        socket,
        'message-too-large',
        'Room messages may be at most 4,096 UTF-8 bytes.',
        1009,
      );
      return;
    }
    const attachment = parseAttachment(socket.deserializeAttachment());
    if (!attachment) {
      rejectSocket(socket, 'invalid-membership', 'Invalid connection state.', 4003);
      return;
    }
    if (attachment.state === 'authenticated') {
      const message = parseAuthenticatedMessage(raw);
      if (message === 'invalid' || message === 'unsupported') {
        const claim = await consumeAuthenticatedMessage(
          this.ctx,
          attachment.playerId,
          attachment.connectionId,
        );
        if (!claim.ok) {
          this.sendActionError(socket, claim.code, claim.message);
          return;
        }
      }
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
      } else if (message.type === 'game/start') {
        await this.startRoundPreparation(socket, attachment.playerId, attachment.connectionId);
      } else if (message.type === 'room/kick') {
        await this.kickMembership(
          socket,
          attachment.playerId,
          attachment.connectionId,
          message.playerId,
        );
      } else {
        await this.processPlayerIntent(
          socket,
          attachment.playerId,
          attachment.connectionId,
          message,
        );
      }
      return;
    }

    const connect = parseConnectMessage(raw);
    const snapshot = await this.loadSnapshot();
    if (!connect || !snapshot) {
      rejectSocket(socket, 'invalid-membership', 'The Room Membership is invalid.', 4003);
      return;
    }
    const connectionId = crypto.randomUUID();
    const authentication = await authenticateMembership(
      this.ctx,
      connect.playerId,
      connect.rejoinCredential,
      connectionId,
    );
    if (!authentication.ok) {
      if (authentication.reason === 'rate-limited') {
        rejectSocket(
          socket,
          'rate-limited',
          'This Room Membership sent too many messages. Try again shortly.',
          1008,
        );
      } else {
        rejectSocket(socket, 'invalid-membership', 'The Room Membership is invalid.', 4003);
      }
      return;
    }

    socket.serializeAttachment({
      state: 'authenticated',
      playerId: connect.playerId,
      connectionId,
    });
    for (const existing of this.ctx.getWebSockets()) {
      if (existing === socket) continue;
      const existingAttachment = parseAttachment(existing.deserializeAttachment());
      if (existingAttachment?.state !== 'authenticated') continue;
      if (existingAttachment.playerId !== connect.playerId) continue;
      if (existingAttachment.connectionId !== authentication.previousConnectionId) continue;
      trySend(existing, {
        type: 'room/error',
        code: 'connection-replaced',
        message: 'This Room Membership was opened in another tab.',
      });
      closeSafely(existing, 4001, 'Connection replaced.');
    }
    this.broadcastSync(authentication.snapshot);
  }

  override async alarm(): Promise<void> {
    const result = await processRoomAlarm(this.ctx);
    if (result.kind === 'error') {
      this.broadcastError(result.snapshot, result.code, result.message);
      this.broadcastSync(result.snapshot);
    } else if (result.kind === 'sync') {
      this.broadcastSync(result.snapshot);
    }
  }

  override async webSocketClose(socket: WebSocket): Promise<void> {
    await this.disconnect(socket);
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    await this.disconnect(socket);
  }

  private async startRoundPreparation(
    socket: WebSocket,
    playerId: string,
    connectionId: string,
  ): Promise<void> {
    const result = await startRoundPreparation(this.ctx, playerId, connectionId);
    if (result.kind === 'error') {
      this.sendActionError(socket, result.code, result.message);
    } else {
      this.broadcastSync(result.snapshot);
    }
  }

  private async processPlayerIntent(
    socket: WebSocket,
    playerId: string,
    connectionId: string,
    intent: Exclude<WorkerPlayerIntent, { type: 'game/start' | 'room/kick' }>,
  ): Promise<void> {
    const result = await processPlayerIntent(this.ctx, playerId, connectionId, intent);
    if (result.kind === 'error') {
      this.sendActionError(socket, result.code, result.message);
    } else if (result.kind === 'sync') {
      this.broadcastSync(result.snapshot);
    }
  }

  private async kickMembership(
    socket: WebSocket,
    actorId: string,
    actorConnectionId: string,
    targetId: string,
  ): Promise<void> {
    const result = await kickMembership(this.ctx, actorId, actorConnectionId, targetId);
    if (result.kind === 'error') {
      this.sendActionError(socket, result.code, result.message);
      return;
    }
    for (const target of this.ctx.getWebSockets()) {
      const attachment = parseAttachment(target.deserializeAttachment());
      if (
        attachment?.state !== 'authenticated' ||
        attachment.playerId !== targetId ||
        attachment.connectionId !== result.connectionId
      ) {
        continue;
      }
      trySend(target, {
        type: 'room/error',
        code: 'kicked',
        message: 'The host removed you from the Room.',
      });
      closeSafely(target, 4003, 'Removed by host.');
    }
    this.broadcastSync(result.snapshot);
  }

  private async disconnect(socket: WebSocket): Promise<void> {
    const attachment = parseAttachment(socket.deserializeAttachment());
    if (attachment?.state !== 'authenticated') return;
    const result = await disconnectMembership(
      this.ctx,
      attachment.playerId,
      attachment.connectionId,
    );
    if (result.kind === 'sync') this.broadcastSync(result.snapshot);
  }

  private sendActionError(socket: WebSocket, code: ErrorCode, message: string): void {
    if (code === 'rate-limited') {
      rejectSocket(socket, code, message, 1008);
      return;
    }
    send(socket, { type: 'room/error', code, message });
  }

  private broadcastSync(snapshot: RoomSnapshot): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = parseAttachment(socket.deserializeAttachment());
      if (attachment?.state !== 'authenticated') continue;
      if (
        snapshot.memberships[attachment.playerId]?.activeConnectionId !== attachment.connectionId
      ) {
        continue;
      }
      sendSync(socket, snapshot, attachment.playerId);
    }
  }

  private broadcastError(snapshot: RoomSnapshot, code: ErrorCode, message: string): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = parseAttachment(socket.deserializeAttachment());
      if (attachment?.state !== 'authenticated') continue;
      if (
        snapshot.memberships[attachment.playerId]?.activeConnectionId !== attachment.connectionId
      ) {
        continue;
      }
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
