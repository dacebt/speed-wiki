import { decide, initialRoom, reduce, type CoreRoom } from '@wikispeedrun/game';
import { describe, expect, test } from 'vitest';
import { ROOM_SNAPSHOT_VERSION, parseRoomSnapshot, type RoomSnapshot } from './snapshot.js';

const HOST_ID = '1f6f49f6-30d5-4fb7-bab8-d015bf878fe8';
const OTHER_ID = 'c61ecdb5-0476-4503-953b-04567336f436';
const DIGEST = 'a'.repeat(64);

describe('durable Room snapshot validation', () => {
  test.each([
    [
      'non-finite player score',
      (snapshot: RoomSnapshot) => (snapshot.room.players[0]!.score = NaN),
    ],
    ['fractional round count', (snapshot: RoomSnapshot) => (snapshot.room.roundsPlayed = 0.5)],
    [
      'out-of-range settings',
      (snapshot: RoomSnapshot) => (snapshot.room.settings.roundDurationMs = 1),
    ],
    [
      'duplicate Player IDs',
      (snapshot: RoomSnapshot) => snapshot.room.players.push({ ...snapshot.room.players[0]! }),
    ],
    [
      'missing Membership',
      (snapshot: RoomSnapshot) => {
        delete snapshot.memberships[HOST_ID];
      },
    ],
    [
      'extra Membership',
      (snapshot: RoomSnapshot) => {
        snapshot.memberships[OTHER_ID] = { credentialDigest: DIGEST };
      },
    ],
    [
      'missing host',
      (snapshot: RoomSnapshot) => {
        snapshot.room.players[0]!.isHost = false;
      },
    ],
    [
      'lobby with countdown deadline',
      (snapshot: RoomSnapshot) => {
        snapshot.room.countdownEndsAt = 1;
      },
    ],
    [
      'countdown without deadline',
      (snapshot: RoomSnapshot) => {
        snapshot.room.phase = 'countdown';
      },
    ],
    [
      'racing without round',
      (snapshot: RoomSnapshot) => {
        snapshot.room.phase = 'racing';
      },
    ],
    [
      'results without round',
      (snapshot: RoomSnapshot) => {
        snapshot.room.phase = 'results';
      },
    ],
  ])('rejects %s', (_label, mutate) => {
    const snapshot = validSnapshot();
    mutate(snapshot);
    expect(() => parseRoomSnapshot(snapshot)).toThrow();
  });

  test('accepts the persisted one-host lobby', () => {
    expect(parseRoomSnapshot(validSnapshot())).toEqual(validSnapshot());
  });

  test.each([
    [
      'snapshot',
      (snapshot: RoomSnapshot) => {
        Object.assign(snapshot, { extra: true });
      },
    ],
    [
      'Room',
      (snapshot: RoomSnapshot) => {
        Object.assign(snapshot.room, { extra: true });
      },
    ],
    [
      'settings',
      (snapshot: RoomSnapshot) => {
        Object.assign(snapshot.room.settings, { extra: true });
      },
    ],
    [
      'player',
      (snapshot: RoomSnapshot) => {
        Object.assign(snapshot.room.players[0]!, { extra: true });
      },
    ],
    [
      'cosmetics',
      (snapshot: RoomSnapshot) => {
        Object.assign(snapshot.room.players[0]!.cosmetics, { extra: true });
      },
    ],
    [
      'Membership record',
      (snapshot: RoomSnapshot) => {
        Object.assign(snapshot.memberships[HOST_ID]!, { rejoinCredential: 'must-not-persist' });
      },
    ],
    [
      'Memberships map',
      (snapshot: RoomSnapshot) => {
        snapshot.memberships.notAPlayerId = { credentialDigest: DIGEST };
      },
    ],
  ])('rejects an unknown key on %s', (_label, mutate) => {
    const snapshot = validSnapshot();
    mutate(snapshot);
    expect(() => parseRoomSnapshot(snapshot)).toThrow();
  });

  test.each([
    [
      'non-finite round deadline',
      (snapshot: RoomSnapshot) => {
        snapshot.room.round!.deadline = Infinity;
      },
    ],
    [
      'fractional round number',
      (snapshot: RoomSnapshot) => {
        snapshot.room.round!.roundNumber = 1.5;
      },
    ],
    [
      'deadline that disagrees with round settings',
      (snapshot: RoomSnapshot) => {
        snapshot.room.round!.deadline += 1;
      },
    ],
    [
      'racing round number that disagrees with completed rounds',
      (snapshot: RoomSnapshot) => {
        snapshot.room.roundsPlayed = 1;
      },
    ],
    [
      'player path that does not begin at the round start',
      (snapshot: RoomSnapshot) => {
        snapshot.room.players[0]!.path = ['Elsewhere'];
      },
    ],
  ])('rejects %s', (_label, mutate) => {
    const snapshot = racingSnapshot();
    mutate(snapshot);
    expect(() => parseRoomSnapshot(snapshot)).toThrow();
  });

  test('accepts a coherent active round', () => {
    expect(parseRoomSnapshot(racingSnapshot())).toEqual(racingSnapshot());
  });

  test('rejects an unknown key on round', () => {
    const snapshot = racingSnapshot();
    Object.assign(snapshot.room.round!, { extra: true });
    expect(() => parseRoomSnapshot(snapshot)).toThrow();
  });
});

function validSnapshot(): RoomSnapshot {
  const created = createHost(initialRoom('ABCD'));
  const room = { ...created, settings: { ...created.settings } };
  return {
    schemaVersion: ROOM_SNAPSHOT_VERSION,
    room,
    memberships: { [HOST_ID]: { credentialDigest: DIGEST } },
  };
}

function createHost(room: CoreRoom): CoreRoom {
  const decision = decide(room, {
    kind: 'client',
    playerId: HOST_ID,
    at: 1,
    intent: { type: 'room/create', playerName: 'Ada', playerId: HOST_ID },
  });
  if (!decision.ok) throw new Error(decision.message);
  return decision.events.reduce(reduce, room);
}

function racingSnapshot(): RoomSnapshot {
  const snapshot = validSnapshot();
  snapshot.room.phase = 'racing';
  snapshot.room.round = {
    roundNumber: 1,
    startArticle: 'Ada Lovelace',
    goalArticle: 'Analytical Engine',
    startedAt: 1_000,
    deadline: 601_000,
  };
  snapshot.room.players[0]!.path = ['Ada Lovelace'];
  return snapshot;
}
