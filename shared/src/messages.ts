import type { PlayerCosmetics } from './cosmetics.js';
import type { RoomSync } from './room.js';

// Every client→server intent and server→client message, defined once.
// Clients send intents; the server decides; clients render what they're told.

export type ClientIntent =
  | { type: 'room/create'; playerName: string }
  | { type: 'room/join'; code: string; playerName: string }
  | { type: 'player/setCosmetics'; cosmetics: PlayerCosmetics }
  | { type: 'game/start'; hardMode: boolean }
  | { type: 'race/hop'; article: string }
  | { type: 'race/giveUp' }
  | { type: 'game/playAgain' };

export type ErrorCode =
  | 'room-not-found'
  | 'invalid-name'
  | 'invalid-cosmetics'
  | 'not-host'
  | 'not-in-room'
  | 'wrong-phase'
  | 'article-fetch-failed';

export type ServerMessage =
  /** `at` is the server clock at send time — clients derive a clock offset
      from it so countdowns and deadlines render correctly despite skew. */
  | { type: 'room/sync'; room: RoomSync; you: string; at: number }
  | { type: 'room/error'; code: ErrorCode; message: string };

/** Socket.io event name for client→server intents. */
export const INTENT_EVENT = 'intent';
/** Socket.io event name for server→client messages. */
export const MESSAGE_EVENT = 'message';
