import type { PlayerCosmetics } from './cosmetics.js';

// The full room state the server broadcasts on every change. Clients render
// this and nothing else — no client-side authority.

export type RoomPhase = 'lobby' | 'countdown' | 'racing' | 'results';

export interface PlayerView {
  id: string;
  name: string;
  cosmetics: PlayerCosmetics;
  isHost: boolean;
  /** Session score, accumulated across rounds. */
  score: number;
  /** Points awarded for the round just ended; 0 while racing. Server-computed. */
  roundPoints: number;
  /** Articles visited this round, in order, starting with the start article. */
  path: string[];
  /** Legal hops made this round (path.length - 1, kept explicit for display). */
  clicks: number;
  /** 1-based finish position this round, null while still racing. */
  finishedRank: number | null;
  /** Milliseconds from round start to finish, null while still racing. */
  finishedAfterMs: number | null;
  /** True if the player conceded this round. */
  gaveUp: boolean;
}

export interface RoundView {
  roundNumber: number;
  startArticle: string;
  goalArticle: string;
  hardMode: boolean;
  /** Server epoch ms when racing began. */
  startedAt: number;
  /** Server epoch ms when the round times out. */
  deadline: number;
}

export interface RoomSync {
  code: string;
  phase: RoomPhase;
  players: PlayerView[];
  /** Present during racing, and in results for the round just run; null in lobby and countdown. */
  round: RoundView | null;
  /** Server epoch ms when the countdown ends; present only in countdown phase. */
  countdownEndsAt: number | null;
}

export const MAX_NAME_LENGTH = 20;
export const ROOM_CODE_LENGTH = 4;
