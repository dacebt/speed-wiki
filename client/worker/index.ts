import {
  MAX_NAME_LENGTH,
  ROOM_CODE_ALPHABET,
  normalizeRoomCode,
  type ApiErrorResponse,
  type CreateRoomResponse,
  type ErrorCode,
} from '@wikispeedrun/shared';
import { RoomDurableObject } from './room.js';

export { RoomDurableObject };

const CREATE_ATTEMPTS = 8;
const ROOM_WEBSOCKET_ROUTE = /^\/api\/rooms\/([^/]+)\/websocket$/;

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === 'POST' && url.pathname === '/api/rooms') {
        return await createRoom(request, env);
      }

      const match = ROOM_WEBSOCKET_ROUTE.exec(url.pathname);
      if (request.method === 'GET' && match) {
        const code = normalizeRoomCode(match[1] ?? '');
        if (!code) return errorResponse(404, 'room-not-found', 'No room found with that code.');
        if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
          return errorResponse(400, 'invalid-request', 'Expected a WebSocket upgrade.');
        }
        return env.ROOMS.getByName(code).fetch(request);
      }

      if (url.pathname.startsWith('/api/')) {
        return errorResponse(404, 'room-not-found', 'No API route found.');
      }
      return env.ASSETS.fetch(request);
    } catch {
      return errorResponse(
        500,
        'internal-error',
        'The Room service could not complete the request.',
      );
    }
  },
} satisfies ExportedHandler<Env>;

async function createRoom(request: Request, env: Env): Promise<Response> {
  const playerName = await parsePlayerName(request);
  if (playerName === null) {
    return errorResponse(400, 'invalid-request', 'Expected JSON with only a playerName string.');
  }
  const trimmedName = playerName.trim();
  if (trimmedName.length === 0 || trimmedName.length > MAX_NAME_LENGTH) {
    return errorResponse(400, 'invalid-name', `Names must be 1–${MAX_NAME_LENGTH} characters.`);
  }

  for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt += 1) {
    const code = generateRoomCode();
    const result = await env.ROOMS.getByName(code).createRoom(code, trimmedName);
    if (result.ok) {
      const response: CreateRoomResponse = {
        roomCode: result.roomCode,
        playerId: result.playerId,
        rejoinCredential: result.rejoinCredential,
      };
      return jsonResponse(response, 201);
    }
    if (result.reason !== 'claimed') {
      return errorResponse(400, 'invalid-request', 'The Room could not be initialized.');
    }
  }
  return errorResponse(503, 'room-unavailable', 'No Room code is available right now.');
}

async function parsePlayerName(request: Request): Promise<string | null> {
  try {
    const value: unknown = await request.json();
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    return Object.keys(record).length === 1 && typeof record.playerName === 'string'
      ? record.playerName
      : null;
  } catch {
    return null;
  }
}

function generateRoomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (byte) => ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length]!).join(
    '',
  );
}

function errorResponse(status: number, code: ErrorCode, message: string): Response {
  return jsonResponse({ error: { code, message } } satisfies ApiErrorResponse, status);
}

function jsonResponse(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}
