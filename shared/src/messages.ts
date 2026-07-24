import type { PlayerCosmetics } from './cosmetics.js';
import type { RoomSettings, RoomSync } from './room.js';

// Every client→server intent and server→client message, defined once.
// Clients send intents; the server decides; clients render what they're told.

export const ROOM_MEMBERSHIP_LIMIT = 8;
export const WEBSOCKET_MESSAGE_BYTE_LIMIT = 4_096;
export const MEMBERSHIP_MESSAGE_RATE_LIMIT = {
  messages: 20,
  windowMs: 10_000,
} as const;
export const PLAYER_ROUND_HOP_LIMIT = 100;

export type ClientIntent =
  // The legacy server accepts its client-generated playerId here. The Worker
  // boundary never trusts this shape for Membership creation: it issues both
  // public identity and secret credential itself.
  | { type: 'room/create'; playerName: string; playerId: string }
  | { type: 'room/join'; code: string; playerName: string; playerId: string }
  | { type: 'player/setCosmetics'; cosmetics: PlayerCosmetics }
  // A partial patch: the host changes one knob at a time and the core merges it
  // into the room's settings, so two quick edits can't clobber each other by
  // each carrying a full object built from stale state.
  | { type: 'room/setSettings'; settings: Partial<RoomSettings> }
  // No payload: difficulty and the durations are read from the room's settings.
  | { type: 'game/start' }
  | { type: 'race/hop'; article: string }
  | { type: 'race/giveUp' }
  | { type: 'game/playAgain' }
  | { type: 'room/kick'; playerId: string };

// Listed at runtime so the client boundary can check membership; the ErrorCode
// type is derived from this list, keeping it the single source of truth.
export const ERROR_CODES = [
  'invalid-request',
  'room-not-found',
  'room-unavailable',
  'invalid-membership',
  'connection-replaced',
  'internal-error',
  'invalid-name',
  'invalid-cosmetics',
  'not-host',
  'not-in-room',
  'wrong-phase',
  'invalid-settings',
  'article-fetch-failed',
  'room-full',
  'message-too-large',
  'rate-limited',
  'hop-limit-reached',
  /** Sent to a player the host removed from the lobby; the client clears its
      room and returns to Home. */
  'kicked',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Public identity assigned by the Room authority. It is safe to render and
    send alongside an authenticated intent, but it does not prove Membership. */
export type PlayerId = string;

/** Secret bearer credential returned once when a Membership is created. */
export type RejoinCredential = string;

export interface CreateRoomRequest {
  playerName: string;
}

export interface CreateRoomResponse {
  roomCode: string;
  playerId: PlayerId;
  rejoinCredential: RejoinCredential;
}

export interface JoinRoomRequest {
  playerName: string;
  /** High-entropy id for one retryable join operation. It is not a Membership
      credential and never appears in Room state or a WebSocket attachment. */
  attemptId: string;
  /** Monotonic request generation within one attempt. Only a newer generation
      may rotate an unpromoted server-issued credential. */
  generation: number;
}

export type JoinRoomResponse = CreateRoomResponse;

export interface RoomConnectMessage {
  type: 'room/connect';
  playerId: PlayerId;
  rejoinCredential: RejoinCredential;
}

export interface ApiErrorResponse {
  error: {
    code: ErrorCode;
    message: string;
  };
}

export type ServerMessage =
  /** `at` is the server clock at send time — clients derive a clock offset
      from it so countdowns and deadlines render correctly despite skew. */
  | { type: 'room/sync'; room: RoomSync; you: string; at: number }
  | { type: 'room/error'; code: ErrorCode; message: string };

/** Socket.io event name for client→server intents. */
export const INTENT_EVENT = 'intent';
/** Socket.io event name for server→client messages. */
export const MESSAGE_EVENT = 'message';
