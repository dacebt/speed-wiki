import type { PlayerCosmetics } from './cosmetics.js';

// The full room state the server broadcasts on every change. Clients render
// this and nothing else — no client-side authority.

// Article difficulty: 'curated' draws a pair from the hand-picked pool;
// 'random' draws two true-random Wikipedia articles. Listed at runtime so the
// boundary can check membership; the type is derived from the list.
export const DIFFICULTIES = ['curated', 'random'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

// Theme for the curated start/goal pair. 'any' is unconstrained (today's flat
// pool); the rest draw from category-specific reachable pairs. Category applies
// to the curated path only — random difficulty ignores it (see the shell).
export const CATEGORIES = ['any', 'science', 'history', 'geography', 'pop-culture'] as const;
export type Category = (typeof CATEGORIES)[number];

// RoomSettings — the single home for every host-tunable knob. Set in the lobby
// before Start, carried into the round, and read by the core in place of module
// constants. Later capabilities (category) extend this same object, so it is
// designed to grow, not be replaced. Durations enter the core as data:
// deadlines are still (server start time + a setting), so no clock lives there.
export interface RoomSettings {
  roundDurationMs: number;
  countdownMs: number;
  difficulty: Difficulty;
  category: Category;
}

export const DEFAULT_ROOM_SETTINGS: RoomSettings = {
  roundDurationMs: 10 * 60_000,
  countdownMs: 10_000,
  difficulty: 'curated',
  category: 'any',
};

// Accepted ranges; the core rejects out-of-range settings rather than clamping.
const ROUND_DURATION_MIN_MS = 60_000; // 1 min
const ROUND_DURATION_MAX_MS = 30 * 60_000; // 30 min
const COUNTDOWN_MIN_MS = 3_000; // 3 s
const COUNTDOWN_MAX_MS = 15_000; // 15 s

/** Domain validity of host-chosen settings — mirrors isValidCosmetics; the core
    uses it to reject rather than silently coerce out-of-range values. */
export function isRoomSettingsInRange(s: RoomSettings): boolean {
  return (
    Number.isFinite(s.roundDurationMs) &&
    Number.isFinite(s.countdownMs) &&
    s.roundDurationMs >= ROUND_DURATION_MIN_MS &&
    s.roundDurationMs <= ROUND_DURATION_MAX_MS &&
    s.countdownMs >= COUNTDOWN_MIN_MS &&
    s.countdownMs <= COUNTDOWN_MAX_MS &&
    (DIFFICULTIES as readonly string[]).includes(s.difficulty) &&
    (CATEGORIES as readonly string[]).includes(s.category)
  );
}

// Listed at runtime so the client boundary can check membership; the RoomPhase
// type is derived from this list, keeping it the single source of truth.
export const ROOM_PHASES = ['lobby', 'preparing', 'countdown', 'racing', 'results'] as const;

export type RoomPhase = (typeof ROOM_PHASES)[number];

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
  /** True while the player's socket is dropped but their slot is held for a rejoin. */
  away: boolean;
}

export interface RoundView {
  roundNumber: number;
  startArticle: string;
  goalArticle: string;
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
  /** Host-chosen knobs, edited in the lobby and applied at Start. */
  settings: RoomSettings;
}

export const MAX_NAME_LENGTH = 20;
export const ROOM_CODE_LENGTH = 4;
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Validate and normalize a Room code before a transport allocates its
    authoritative Durable Object. */
export function normalizeRoomCode(value: string): string | null {
  const code = value.trim().toUpperCase();
  if (code.length !== ROOM_CODE_LENGTH) return null;
  return [...code].every((character) => ROOM_CODE_ALPHABET.includes(character)) ? code : null;
}
