import {
  DIFFICULTIES,
  ERROR_CODES,
  ROOM_PHASES,
  type ErrorCode,
  type PlayerCosmetics,
  type PlayerView,
  type RoomSettings,
  type RoomSync,
  type RoundView,
  type ServerMessage,
} from '@wikispeedrun/shared';

// Boundary validation for server→client messages. Socket bytes are untrusted
// until they structurally match a known message, so the store only ever sees a
// well-formed ServerMessage. The guards mirror the wire types in shared/ (the
// single source of truth) but are fully hand-maintained: they run over
// `unknown`, so TypeScript does not check them against the shared types and no
// drift — added, removed, or retyped fields — is caught at build time. Any
// change to a wire type in shared/ must be mirrored here by hand. Validation
// is shape-only — domain legality (e.g. whether a cosmetic id is in the
// catalog) is the server's authority.

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumberOrNull(value: unknown): value is number | null {
  return value === null || typeof value === 'number';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isCosmetics(value: unknown): value is PlayerCosmetics {
  return isRecord(value) && typeof value.faceId === 'string' && typeof value.hatId === 'string';
}

function isPlayerView(value: unknown): value is PlayerView {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    isCosmetics(value.cosmetics) &&
    typeof value.isHost === 'boolean' &&
    typeof value.score === 'number' &&
    typeof value.roundPoints === 'number' &&
    isStringArray(value.path) &&
    typeof value.clicks === 'number' &&
    isNumberOrNull(value.finishedRank) &&
    isNumberOrNull(value.finishedAfterMs) &&
    typeof value.gaveUp === 'boolean' &&
    typeof value.away === 'boolean'
  );
}

function isRoundView(value: unknown): value is RoundView {
  return (
    isRecord(value) &&
    typeof value.roundNumber === 'number' &&
    typeof value.startArticle === 'string' &&
    typeof value.goalArticle === 'string' &&
    typeof value.startedAt === 'number' &&
    typeof value.deadline === 'number'
  );
}

function isRoomSettings(value: unknown): value is RoomSettings {
  return (
    isRecord(value) &&
    typeof value.roundDurationMs === 'number' &&
    typeof value.countdownMs === 'number' &&
    (DIFFICULTIES as readonly string[]).includes(value.difficulty as string)
  );
}

function isRoomSync(value: unknown): value is RoomSync {
  return (
    isRecord(value) &&
    typeof value.code === 'string' &&
    (ROOM_PHASES as readonly string[]).includes(value.phase as string) &&
    Array.isArray(value.players) &&
    value.players.every(isPlayerView) &&
    (value.round === null || isRoundView(value.round)) &&
    isNumberOrNull(value.countdownEndsAt) &&
    isRoomSettings(value.settings)
  );
}

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

export function parseServerMessage(raw: unknown): ServerMessage | null {
  if (!isRecord(raw)) return null;

  if (raw.type === 'room/sync') {
    return typeof raw.you === 'string' && typeof raw.at === 'number' && isRoomSync(raw.room)
      ? { type: 'room/sync', room: raw.room, you: raw.you, at: raw.at }
      : null;
  }

  if (raw.type === 'room/error') {
    return isErrorCode(raw.code) && typeof raw.message === 'string'
      ? { type: 'room/error', code: raw.code, message: raw.message }
      : null;
  }

  return null;
}
