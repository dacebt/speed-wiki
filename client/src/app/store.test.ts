import type { RoomSync } from '@wikispeedrun/shared';
import { describe, expect, test } from 'vitest';
import { reduceAppState, shouldClearLastRoom, type AppState } from './storeState.js';

const PLAYER_ID = '1f6f49f6-30d5-4fb7-bab8-d015bf878fe8';

describe('transport disconnect state', () => {
  test('terminal Worker disconnect leaves the Room and publishes its notice', () => {
    const next = reduceAppState(inRoom(), {
      type: 'socket/disconnected',
      disconnect: {
        type: 'terminal',
        code: 'room-unavailable',
        message: 'The Room connection was lost.',
      },
    });

    expect(next.room).toBeNull();
    expect(next.reconnecting).toBe(false);
    expect(next.notice).toEqual({
      code: 'room-unavailable',
      message: 'The Room connection was lost.',
    });
  });

  test('legacy recoverable disconnect keeps the Room while reconnecting', () => {
    const next = reduceAppState(inRoom(), {
      type: 'socket/disconnected',
      disconnect: { type: 'reconnecting' },
    });

    expect(next.room?.code).toBe('ABCD');
    expect(next.reconnecting).toBe(true);
    expect(next.notice).toBeNull();
  });

  test('replacement and retry exhaustion preserve the shared last-Room pointer', () => {
    for (const code of ['connection-replaced', 'room-unavailable'] as const) {
      const state = reduceAppState(inRoom(), {
        type: 'socket/disconnected',
        disconnect: { type: 'terminal', code, message: 'Connection ended.' },
      });
      expect(shouldClearLastRoom(state)).toBe(false);
    }
  });

  test('authoritative Membership loss clears the last-Room pointer', () => {
    for (const code of ['room-not-found', 'invalid-membership', 'kicked'] as const) {
      expect(
        shouldClearLastRoom({
          ...inRoom(),
          room: null,
          notice: { code, message: 'Membership ended.' },
        }),
      ).toBe(true);
    }
  });
});

function inRoom(): AppState {
  return {
    connected: true,
    you: PLAYER_ID,
    room: lobby(),
    clockOffset: 0,
    reconnecting: false,
    notice: null,
  };
}

function lobby(): RoomSync {
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
