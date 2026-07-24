import { toRoomSync } from '@wikispeedrun/game';
import type { ErrorCode, RoomConnectMessage, ServerMessage } from '@wikispeedrun/shared';
import type { RoomSnapshot } from './snapshot.js';

type PendingAttachment = { state: 'pending' };
type AuthenticatedAttachment = { state: 'authenticated'; playerId: string };
export type ConnectionAttachment = PendingAttachment | AuthenticatedAttachment;
type SocketWriter = Pick<WebSocket, 'send' | 'close'>;

export function parseAttachment(value: unknown): ConnectionAttachment | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (hasExactKeys(record, ['state']) && record.state === 'pending') return { state: 'pending' };
  return hasExactKeys(record, ['state', 'playerId']) &&
    record.state === 'authenticated' &&
    typeof record.playerId === 'string' &&
    isUuid(record.playerId)
    ? { state: 'authenticated', playerId: record.playerId }
    : null;
}

export function parseConnectMessage(raw: string | ArrayBuffer): RoomConnectMessage | null {
  if (typeof raw !== 'string') return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    return hasExactKeys(record, ['type', 'playerId', 'rejoinCredential']) &&
      record.type === 'room/connect' &&
      typeof record.playerId === 'string' &&
      isUuid(record.playerId) &&
      typeof record.rejoinCredential === 'string' &&
      /^[A-Za-z0-9_-]{43}$/.test(record.rejoinCredential)
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

export function send(socket: SocketWriter, message: ServerMessage): void {
  socket.send(JSON.stringify(message));
}

export function trySend(socket: SocketWriter, message: ServerMessage): boolean {
  try {
    send(socket, message);
    return true;
  } catch {
    return false;
  }
}

export function sendSync(socket: SocketWriter, snapshot: RoomSnapshot, playerId: string): void {
  trySend(socket, {
    type: 'room/sync',
    room: toRoomSync(snapshot.room),
    you: playerId,
    at: Date.now(),
  });
}

export function closeSafely(socket: SocketWriter, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // The Connection is already gone.
  }
}

export function rejectSocket(
  socket: SocketWriter,
  code: ErrorCode,
  message: string,
  closeCode: number,
): void {
  trySend(socket, { type: 'room/error', code, message });
  closeSafely(socket, closeCode, message);
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
