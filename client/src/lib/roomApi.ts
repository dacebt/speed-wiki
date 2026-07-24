import {
  ERROR_CODES,
  normalizeRoomCode,
  type ApiErrorResponse,
  type ErrorCode,
} from '@wikispeedrun/shared';
import type { RoomMembership } from './transportTypes.js';

const REQUEST_DEADLINE_MS = 10_000;

export class RoomRequestError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export async function createRoomMembership(playerName: string): Promise<RoomMembership> {
  return requestMembership('/api/rooms', { playerName });
}

export async function joinRoomMembership(
  playerName: string,
  roomCode: string,
): Promise<RoomMembership> {
  const attemptId = crypto.randomUUID();
  let lastFailure: RoomRequestError | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await requestMembership(`/api/rooms/${roomCode}/memberships`, {
        playerName,
        attemptId,
        generation: attempt,
      });
    } catch (error) {
      if (!(error instanceof RoomRequestError) || error.code !== 'room-unavailable') throw error;
      lastFailure = error;
    }
  }
  throw lastFailure ?? new RoomRequestError('room-unavailable', 'The Room request failed.');
}

async function requestMembership(
  path: string,
  body: { playerName: string; attemptId?: string; generation?: number },
): Promise<RoomMembership> {
  const controller = new AbortController();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    deadline = setTimeout(() => {
      controller.abort();
      reject(new RoomRequestError('room-unavailable', 'The Room request timed out.'));
    }, REQUEST_DEADLINE_MS);
  });
  let result: { response: Response; raw: unknown };
  try {
    result = await Promise.race([
      fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      }).then(async (response) => ({
        response,
        raw: await response.json().catch(() => null),
      })),
      timedOut,
    ]);
  } catch (error) {
    if (error instanceof RoomRequestError) throw error;
    throw new RoomRequestError('room-unavailable', 'The Room service could not be reached.');
  } finally {
    clearTimeout(deadline);
  }

  if (!result.response.ok) {
    const error = parseApiError(result.raw);
    throw new RoomRequestError(
      error?.error.code ?? 'internal-error',
      error?.error.message ?? 'The Room service returned an invalid error.',
    );
  }
  const membership = parseRoomMembershipResponse(result.raw);
  if (!membership) {
    throw new RoomRequestError(
      'internal-error',
      'The Room service returned an invalid Membership.',
    );
  }
  return membership;
}

export function parseRoomMembershipResponse(value: unknown): RoomMembership | null {
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
  if (Object.keys(value).length !== 1) return null;
  const error = (value as Record<string, unknown>).error;
  if (typeof error !== 'object' || error === null || Array.isArray(error)) return null;
  const record = error as Record<string, unknown>;
  return Object.keys(record).length === 2 &&
    typeof record.code === 'string' &&
    (ERROR_CODES as readonly string[]).includes(record.code) &&
    typeof record.message === 'string'
    ? { error: { code: record.code as ErrorCode, message: record.message } }
    : null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
