import type { PlayerCosmetics, RoomPhase, RoundView } from '@wikispeedrun/shared';

// Internal room state, produced only by reducing events. The sync view sent
// to clients is derived from it in view.ts.

export interface CorePlayer {
  id: string;
  name: string;
  cosmetics: PlayerCosmetics;
  isHost: boolean;
  score: number;
  roundPoints: number;
  path: string[];
  finishedRank: number | null;
  finishedAfterMs: number | null;
  gaveUp: boolean;
  /** Socket dropped, slot held pending a rejoin. Not removed until the grace window lapses. */
  away: boolean;
}

export interface CoreRoom {
  code: string;
  phase: RoomPhase;
  players: CorePlayer[];
  round: RoundView | null;
  countdownEndsAt: number | null;
  pendingHardMode: boolean;
  roundsPlayed: number;
  ranksAssigned: number;
}

export function initialRoom(code: string): CoreRoom {
  return {
    code,
    phase: 'lobby',
    players: [],
    round: null,
    countdownEndsAt: null,
    pendingHardMode: false,
    roundsPlayed: 0,
    ranksAssigned: 0,
  };
}

/** Wikipedia titles: underscores and spaces are the same; first char is case-insensitive. */
function normalizeTitle(title: string): string {
  const t = title.replaceAll('_', ' ').trim();
  return t.length === 0 ? t : t[0]!.toUpperCase() + t.slice(1);
}

export function sameArticle(a: string, b: string): boolean {
  return normalizeTitle(a) === normalizeTitle(b);
}
