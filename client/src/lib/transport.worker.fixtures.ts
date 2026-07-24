import type { RoomSync } from '@wikispeedrun/shared';

export const PLAYER_ID = '1f6f49f6-30d5-4fb7-bab8-d015bf878fe8';
export const CREDENTIAL = 'A'.repeat(43);

export function workerTransportLobby(): RoomSync {
  return {
    code: 'ABCD',
    phase: 'lobby',
    players: [
      {
        id: PLAYER_ID,
        name: 'Ada',
        cosmetics: { faceId: 'scholar', hatId: 'none' },
        isHost: true,
        score: 0,
        roundPoints: 0,
        path: [],
        clicks: 0,
        finishedRank: null,
        finishedAfterMs: null,
        gaveUp: false,
        away: false,
      },
    ],
    round: null,
    countdownEndsAt: null,
    settings: {
      roundDurationMs: 600_000,
      countdownMs: 10_000,
      difficulty: 'curated',
      category: 'any',
    },
  };
}
