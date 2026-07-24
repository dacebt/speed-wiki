import type { ErrorCode, RoomSync } from '@wikispeedrun/shared';

export const PLAYER_ID = '1f6f49f6-30d5-4fb7-bab8-d015bf878fe8';
export const CREDENTIAL = 'A'.repeat(43);
export const RECOVERABLE_ACTION_ERROR_CODES: readonly ErrorCode[] = [
  'invalid-request',
  'room-unavailable',
  'invalid-cosmetics',
  'not-host',
  'not-in-room',
  'wrong-phase',
  'invalid-settings',
  'article-fetch-failed',
  'hop-limit-reached',
];

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
