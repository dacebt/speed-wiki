import {
  ERROR_CODES,
  type ApiErrorResponse,
  type ClientIntent,
  type CreateRoomResponse,
  type ErrorCode,
  type RoomConnectMessage,
  type ServerMessage,
} from '@wikispeedrun/shared';
import { normalizeRoomCode } from '@wikispeedrun/shared';
import { parseServerMessage } from './serverMessage.js';
import type { TransportHandlers } from './transportTypes.js';

export const supportsInvitedJoining = false;
export const supportsLobbyActions = false;

const handlers = new Set<TransportHandlers>();
let connection: WebSocket | null = null;
let creationInFlight: Promise<void> | null = null;
const ROOM_CREATION_DEADLINE_MS = 10_000;
const FIRST_SYNC_DEADLINE_MS = 10_000;

export function createRoom(playerName: string): Promise<void> {
  if (creationInFlight) return creationInFlight;
  const attempt = createRoomOnce(playerName);
  const shared = attempt.finally(() => {
    if (creationInFlight === shared) creationInFlight = null;
  });
  creationInFlight = shared;
  return shared;
}

async function createRoomOnce(playerName: string): Promise<void> {
  let result: { response: Response; raw: unknown };
  try {
    result = await requestRoom(playerName);
  } catch (error) {
    const message =
      error instanceof RoomCreationDeadlineError
        ? 'Room creation timed out.'
        : 'The Room service could not be reached.';
    return failCreation('room-unavailable', message);
  }

  if (!result.response.ok) {
    const error = parseApiError(result.raw);
    return failCreation(
      error?.error.code ?? 'internal-error',
      error?.error.message ?? 'The Room service returned an invalid error.',
    );
  }
  const created = parseCreateRoomResponse(result.raw);
  if (!created) {
    return failCreation('internal-error', 'The Room service returned an invalid creation result.');
  }
  await connect(created);
}

export function sendIntent(intent: ClientIntent): void {
  if (connection?.readyState === WebSocket.OPEN) {
    connection.send(JSON.stringify(intent));
    return;
  }
  notifyError('room-unavailable', 'The Room connection is not ready.');
}

export function subscribe(nextHandlers: TransportHandlers): () => void {
  handlers.add(nextHandlers);
  return () => handlers.delete(nextHandlers);
}

function connect(membership: CreateRoomResponse): Promise<void> {
  const url = new URL(`/api/rooms/${membership.roomCode}/websocket`, window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(url);
  const replaced = connection;
  connection = socket;
  replaced?.close(1000, 'Replaced by a new Room connection.');

  return new Promise((resolve, reject) => {
    let settled = false;
    const firstSyncDeadline = setTimeout(() => {
      failBeforeSync('The Room lobby did not become ready in time.');
    }, FIRST_SYNC_DEADLINE_MS);

    const succeed = () => {
      if (settled) return;
      settled = true;
      clearTimeout(firstSyncDeadline);
      resolve();
    };
    const failBeforeSync = (
      message: string,
      code: ErrorCode | 'disconnected' = 'room-unavailable',
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(firstSyncDeadline);
      if (connection === socket) connection = null;
      notifyDisconnect({ type: 'terminal', code, message });
      socket.close(1000, 'Room creation failed.');
      reject(new Error(message));
    };

    socket.addEventListener('open', () => {
      if (connection !== socket) return;
      for (const listener of handlers) listener.onConnect();
      socket.send(
        JSON.stringify({
          type: 'room/connect',
          playerId: membership.playerId,
          rejoinCredential: membership.rejoinCredential,
        } satisfies RoomConnectMessage),
      );
    });
    socket.addEventListener('message', (event) => {
      const message = parseSocketMessage(event.data);
      if (!message) {
        if (!settled) failBeforeSync('The Room service sent an invalid lobby response.');
        return;
      }
      if (
        message.type === 'room/sync' &&
        message.you === membership.playerId &&
        message.room.code === membership.roomCode
      ) {
        if (!settled) {
          try {
            persistMembership(membership);
          } catch {
            failBeforeSync('The Room membership could not be saved.', 'internal-error');
            return;
          }
        }
        notifyMessage(message);
        succeed();
      } else if (message.type === 'room/error') {
        failBeforeSync(message.message, message.code);
      } else if (!settled) {
        failBeforeSync('The Room service sent an unexpected lobby response.');
      } else {
        notifyMessage(message);
      }
    });
    socket.addEventListener('close', () => {
      if (connection !== socket) return;
      connection = null;
      if (!settled) {
        failBeforeSync('The Room connection closed before the lobby was ready.');
        return;
      }
      notifyDisconnect({
        type: 'terminal',
        code: 'room-unavailable',
        message: 'The Room connection was lost. Create a new Room to continue.',
      });
    });
    socket.addEventListener('error', () => {
      if (!settled) {
        failBeforeSync('The Room connection failed.');
        return;
      }
      if (connection !== socket) return;
      connection = null;
      notifyDisconnect({
        type: 'terminal',
        code: 'room-unavailable',
        message: 'The Room connection failed. Create a new Room to continue.',
      });
      socket.close(1011, 'Room connection failed.');
    });
  });
}

async function requestRoom(playerName: string): Promise<{ response: Response; raw: unknown }> {
  const controller = new AbortController();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    deadline = setTimeout(() => {
      controller.abort();
      reject(new RoomCreationDeadlineError());
    }, ROOM_CREATION_DEADLINE_MS);
  });
  try {
    return await Promise.race([
      fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerName }),
        signal: controller.signal,
      }).then(async (response) => ({ response, raw: await response.json().catch(() => null) })),
      timedOut,
    ]);
  } finally {
    clearTimeout(deadline);
  }
}

class RoomCreationDeadlineError extends Error {}

function parseSocketMessage(raw: unknown): ServerMessage | null {
  if (typeof raw !== 'string') return null;
  try {
    return parseServerMessage(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function parseCreateRoomResponse(value: unknown): CreateRoomResponse | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const normalizedCode =
    typeof record.roomCode === 'string' ? normalizeRoomCode(record.roomCode) : null;
  return Object.keys(record).length === 3 &&
    normalizedCode !== null &&
    normalizedCode === record.roomCode &&
    typeof record.playerId === 'string' &&
    isUuid(record.playerId) &&
    typeof record.rejoinCredential === 'string' &&
    /^[A-Za-z0-9_-]{43}$/.test(record.rejoinCredential)
    ? {
        roomCode: normalizedCode,
        playerId: record.playerId,
        rejoinCredential: record.rejoinCredential,
      }
    : null;
}

function parseApiError(value: unknown): ApiErrorResponse | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const error = (value as Record<string, unknown>).error;
  if (typeof error !== 'object' || error === null || Array.isArray(error)) return null;
  const record = error as Record<string, unknown>;
  if (
    typeof record.code !== 'string' ||
    !(ERROR_CODES as readonly string[]).includes(record.code) ||
    typeof record.message !== 'string'
  ) {
    return null;
  }
  return { error: { code: record.code as ErrorCode, message: record.message } };
}

function persistMembership(membership: CreateRoomResponse): void {
  localStorage.setItem(
    `wikispeedrun.room.${membership.roomCode}.membership`,
    JSON.stringify({
      playerId: membership.playerId,
      rejoinCredential: membership.rejoinCredential,
    }),
  );
}

function notifyError(code: ErrorCode, message: string): void {
  notifyMessage({ type: 'room/error', code, message });
}

function failCreation(code: ErrorCode, message: string): never {
  notifyError(code, message);
  throw new Error(message);
}

function notifyMessage(message: ServerMessage): void {
  for (const listener of handlers) listener.onMessage(message);
}

function notifyDisconnect(disconnect: Parameters<TransportHandlers['onDisconnect']>[0]): void {
  for (const listener of handlers) listener.onDisconnect(disconnect);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
