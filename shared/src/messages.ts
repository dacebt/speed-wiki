import type { PlayerCosmetics } from './cosmetics.js';
import type { RoomSettings, RoomSync } from './room.js';

// Every client→server intent and server→client message, defined once.
// Clients send intents; the server decides; clients render what they're told.

export type ClientIntent =
  // playerId is the client-generated, localStorage-persisted identity (see
  // client/src/lib/identity.ts). The server keys players by it, so a create or
  // join carrying a playerId already in the room is a rejoin, not a new player.
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
  'internal-error',
  'invalid-name',
  'invalid-cosmetics',
  'not-host',
  'not-in-room',
  'wrong-phase',
  'invalid-settings',
  'article-fetch-failed',
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
