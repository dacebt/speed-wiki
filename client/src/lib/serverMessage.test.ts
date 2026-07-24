import type { RoomSync } from '@wikispeedrun/shared';
import { describe, expect, test } from 'vitest';
import { parseServerMessage } from './serverMessage.js';
import { PLAYER_ID, workerTransportLobby } from './transport.worker.fixtures.js';

describe('server message exact validation', () => {
  test.each([
    ['sync', (message: SyncRecord) => Object.assign(message, { extra: true })],
    ['Room', (message: SyncRecord) => Object.assign(message.room, { extra: true })],
    ['Player', (message: SyncRecord) => Object.assign(message.room.players[0]!, { extra: true })],
    [
      'cosmetics',
      (message: SyncRecord) => Object.assign(message.room.players[0]!.cosmetics, { extra: true }),
    ],
    ['settings', (message: SyncRecord) => Object.assign(message.room.settings, { extra: true })],
  ])('rejects an extra key on %s', (_label, mutate) => {
    const message = syncRecord();
    mutate(message);
    expect(parseServerMessage(message)).toBeNull();
  });

  test('rejects an extra key on an error', () => {
    expect(
      parseServerMessage({
        type: 'room/error',
        code: 'room-unavailable',
        message: 'Unavailable.',
        extra: true,
      }),
    ).toBeNull();
  });

  test('rejects an extra key on a round', () => {
    const message = syncRecord();
    Object.assign(message.room, {
      phase: 'racing',
      round: {
        roundNumber: 1,
        startArticle: 'Ada Lovelace',
        goalArticle: 'Analytical Engine',
        startedAt: 1,
        deadline: 2,
        extra: true,
      },
    });
    expect(parseServerMessage(message)).toBeNull();
  });
});

interface SyncRecord {
  type: string;
  room: RoomSync;
  you: string;
  at: number;
}

function syncRecord(): SyncRecord {
  return {
    type: 'room/sync',
    room: structuredClone(workerTransportLobby()),
    you: PLAYER_ID,
    at: 1,
  };
}
