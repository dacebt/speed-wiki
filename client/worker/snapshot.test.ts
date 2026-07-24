import { decide, initialRoom, reduce, type CoreRoom } from '@wikispeedrun/game';
import { describe, expect, test } from 'vitest';
import { ROOM_SNAPSHOT_VERSION, parseRoomSnapshot, type RoomSnapshot } from './snapshot.js';

const HOST_ID = '1f6f49f6-30d5-4fb7-bab8-d015bf878fe8';
const OTHER_ID = 'c61ecdb5-0476-4503-953b-04567336f436';
const ATTEMPT_ID = '9e2a5f17-b57f-4ee9-9a7d-b4ae8f2dd1b2';
const OTHER_ATTEMPT_ID = '2297ac68-da58-4cad-94ae-e5f863beab60';
const PREPARATION_TOKEN = '018f1f21-9fd8-4c8a-a639-0f6d40ceefab';
const CONNECTION_ID = '318f1f21-9fd8-4c8a-a639-0f6d40ceefab';
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
        snapshot.memberships[OTHER_ID] = {
          credentialDigest: DIGEST,
          activeConnectionId: OTHER_ATTEMPT_ID,
        };
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

  test('accepts an away Membership only with one matching grace deadline', () => {
    const snapshot = awaySnapshot();
    expect(parseRoomSnapshot(snapshot)).toEqual(snapshot);
  });

  test.each([
    [
      'an away Membership with an active Connection',
      (snapshot: RoomSnapshot) => {
        snapshot.memberships[HOST_ID]!.activeConnectionId = CONNECTION_ID;
      },
    ],
    [
      'an away Membership without grace',
      (snapshot: RoomSnapshot) => {
        snapshot.deadlines = [];
      },
    ],
    [
      'two grace deadlines for one Membership',
      (snapshot: RoomSnapshot) => {
        snapshot.deadlines.push({
          kind: 'membership-grace',
          playerId: HOST_ID,
          connectionId: null,
          at: 2_000,
        });
      },
    ],
    [
      'grace for an unknown Membership',
      (snapshot: RoomSnapshot) => {
        snapshot.deadlines[0] = {
          kind: 'membership-grace',
          playerId: OTHER_ID,
          connectionId: null,
          at: 1_000,
        };
      },
    ],
  ])('rejects %s', (_label, mutate) => {
    const snapshot = awaySnapshot();
    mutate(snapshot);
    expect(() => parseRoomSnapshot(snapshot)).toThrow();
  });

  test('rejects more than one phase deadline', () => {
    const snapshot = preparingSnapshot();
    snapshot.deadlines.push({
      kind: 'round-preparation',
      token: OTHER_ATTEMPT_ID,
      at: 2_000,
    });
    expect(() => parseRoomSnapshot(snapshot)).toThrow('Invalid Room snapshot Deadlines.');
  });

  test('rejects a grace Connection ID that aliases another active Connection', () => {
    const snapshot = twoPlayerSnapshot();
    snapshot.room.players[0]!.away = true;
    snapshot.memberships[HOST_ID]!.activeConnectionId = null;
    snapshot.deadlines = [
      {
        kind: 'membership-grace',
        playerId: HOST_ID,
        connectionId: OTHER_ATTEMPT_ID,
        at: 1_000,
      },
    ];
    expect(() => parseRoomSnapshot(snapshot)).toThrow('Connection ownership');
  });

  test('rejects a null grace outside the single initial-host allocation shape', () => {
    const snapshot = twoPlayerSnapshot();
    snapshot.room.players[0]!.away = true;
    snapshot.memberships[HOST_ID]!.activeConnectionId = null;
    snapshot.deadlines = [
      {
        kind: 'membership-grace',
        playerId: HOST_ID,
        connectionId: null,
        at: 1_000,
      },
    ];
    expect(() => parseRoomSnapshot(snapshot)).toThrow('Connection ownership');
  });

  test('rejects more than one null grace', () => {
    const snapshot = twoPlayerSnapshot();
    for (const player of snapshot.room.players) player.away = true;
    for (const membership of Object.values(snapshot.memberships)) {
      membership.activeConnectionId = null;
    }
    snapshot.deadlines = snapshot.room.players.map((player) => ({
      kind: 'membership-grace' as const,
      playerId: player.id,
      connectionId: null,
      at: 1_000,
    }));
    expect(() => parseRoomSnapshot(snapshot)).toThrow('Connection ownership');
  });

  test('accepts exact preparing and countdown recovery states', () => {
    const preparing = preparingSnapshot();
    expect(parseRoomSnapshot(preparing)).toEqual(preparing);
    const countdown = countdownSnapshot();
    expect(parseRoomSnapshot(countdown)).toEqual(countdown);
  });

  test.each([
    [
      'preparing without a preparation',
      (snapshot: RoomSnapshot) => {
        snapshot.roundPreparation = null;
      },
    ],
    [
      'preparing with a selected pair',
      (snapshot: RoomSnapshot) => {
        snapshot.roundPreparation!.pair = {
          startArticle: 'Ada Lovelace',
          goalArticle: 'Analytical Engine',
        };
      },
    ],
    [
      'preparing with a countdown deadline',
      (snapshot: RoomSnapshot) => {
        snapshot.deadlines[0]!.kind = 'countdown';
      },
    ],
    [
      'preparing with mismatched tokens',
      (snapshot: RoomSnapshot) => {
        if (snapshot.deadlines[0]!.kind === 'membership-grace') throw new Error('Expected phase.');
        snapshot.deadlines[0]!.token = OTHER_ATTEMPT_ID;
      },
    ],
    [
      'preparing with settings that differ from its request',
      (snapshot: RoomSnapshot) => {
        snapshot.roundPreparation!.category = 'history';
      },
    ],
  ])('rejects %s', (_label, mutate) => {
    const snapshot = preparingSnapshot();
    mutate(snapshot);
    expect(() => parseRoomSnapshot(snapshot)).toThrow('pending runtime state');
  });

  test.each([
    [
      'countdown without a pair',
      (snapshot: RoomSnapshot) => {
        snapshot.roundPreparation!.pair = null;
      },
    ],
    [
      'countdown deadline that disagrees with the Room',
      (snapshot: RoomSnapshot) => {
        snapshot.deadlines[0]!.at += 1;
      },
    ],
    [
      'countdown with a preparation deadline',
      (snapshot: RoomSnapshot) => {
        snapshot.deadlines[0]!.kind = 'round-preparation';
      },
    ],
  ])('rejects %s', (_label, mutate) => {
    const snapshot = countdownSnapshot();
    mutate(snapshot);
    expect(() => parseRoomSnapshot(snapshot)).toThrow('pending runtime state');
  });

  test('rejects outer whitespace in a prepared article pair', () => {
    const snapshot = countdownSnapshot();
    snapshot.roundPreparation!.pair!.startArticle = ' Ada Lovelace';
    expect(() => parseRoomSnapshot(snapshot)).toThrow('Invalid Room snapshot Round preparation.');
  });

  test('accepts an exact pending join reservation outside visible Room state', () => {
    const snapshot = validSnapshot();
    snapshot.joinAttempts[ATTEMPT_ID] = {
      state: 'pending',
      playerId: OTHER_ID,
      playerName: 'Guest',
      credentialDigest: DIGEST,
      generation: 0,
    };
    expect(parseRoomSnapshot(snapshot)).toEqual(snapshot);
  });

  test('rejects a pending join reservation that already has visible authority', () => {
    const snapshot = validSnapshot();
    snapshot.joinAttempts[ATTEMPT_ID] = {
      state: 'pending',
      playerId: HOST_ID,
      playerName: 'Ada',
      credentialDigest: DIGEST,
      generation: 0,
    };
    expect(() => parseRoomSnapshot(snapshot)).toThrow('Invalid pending join attempt.');
  });

  test('rejects a pending join reservation with an invalid generation', () => {
    const snapshot = validSnapshot();
    snapshot.joinAttempts[ATTEMPT_ID] = {
      state: 'pending',
      playerId: OTHER_ID,
      playerName: 'Guest',
      credentialDigest: DIGEST,
      generation: -1,
    };
    expect(() => parseRoomSnapshot(snapshot)).toThrow('Invalid Room snapshot join attempts.');
  });

  test('rejects a promoted join attempt without its Player and Membership', () => {
    const snapshot = validSnapshot();
    snapshot.joinAttempts[ATTEMPT_ID] = { state: 'promoted', playerId: OTHER_ID };
    expect(() => parseRoomSnapshot(snapshot)).toThrow('Invalid promoted join attempt.');
  });

  test('rejects two pending attempts that alias one reserved Player ID', () => {
    const snapshot = validSnapshot();
    const pending = {
      state: 'pending' as const,
      playerId: OTHER_ID,
      playerName: 'Guest',
      credentialDigest: DIGEST,
      generation: 0,
    };
    snapshot.joinAttempts[ATTEMPT_ID] = pending;
    snapshot.joinAttempts[OTHER_ATTEMPT_ID] = { ...pending, generation: 1 };
    expect(() => parseRoomSnapshot(snapshot)).toThrow(
      'Invalid join attempt Player identity aliases.',
    );
  });

  test('rejects two promoted attempts that alias one Membership', () => {
    const snapshot = validSnapshot();
    snapshot.joinAttempts[ATTEMPT_ID] = { state: 'promoted', playerId: HOST_ID };
    snapshot.joinAttempts[OTHER_ATTEMPT_ID] = { state: 'promoted', playerId: HOST_ID };
    expect(() => parseRoomSnapshot(snapshot)).toThrow(
      'Invalid join attempt Player identity aliases.',
    );
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
        snapshot.memberships.notAPlayerId = {
          credentialDigest: DIGEST,
          activeConnectionId: CONNECTION_ID,
        };
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

  test.each([
    [
      'missing racing timeout',
      (snapshot: RoomSnapshot) => {
        snapshot.deadlines = [];
      },
    ],
    [
      'wrong racing timeout kind',
      (snapshot: RoomSnapshot) => {
        Object.assign(snapshot.deadlines[0]!, {
          kind: 'countdown',
          token: PREPARATION_TOKEN,
        });
      },
    ],
    [
      'wrong racing timeout token',
      (snapshot: RoomSnapshot) => {
        if (snapshot.deadlines[0]!.kind === 'membership-grace') throw new Error('Expected phase.');
        snapshot.deadlines[0]!.token = 'round:2:1000';
      },
    ],
    [
      'wrong racing timeout instant',
      (snapshot: RoomSnapshot) => {
        snapshot.deadlines[0]!.at += 1;
      },
    ],
  ])('rejects %s', (_label, mutate) => {
    const snapshot = racingSnapshot();
    mutate(snapshot);
    expect(() => parseRoomSnapshot(snapshot)).toThrow('pending runtime state');
  });

  test('accepts results only after the racing timeout is cleared', () => {
    const snapshot = resultsSnapshot();
    expect(parseRoomSnapshot(snapshot)).toEqual(snapshot);
    snapshot.deadlines = [
      {
        kind: 'round-timeout',
        token: 'round:1:1000',
        at: 601_000,
      },
    ];
    expect(() => parseRoomSnapshot(snapshot)).toThrow('pending runtime state');
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
    memberships: {
      [HOST_ID]: { credentialDigest: DIGEST, activeConnectionId: CONNECTION_ID },
    },
    joinAttempts: {},
    roundPreparation: null,
    deadlines: [],
  };
}

function awaySnapshot(): RoomSnapshot {
  const snapshot = validSnapshot();
  snapshot.room.players[0]!.away = true;
  snapshot.memberships[HOST_ID]!.activeConnectionId = null;
  snapshot.deadlines = [
    {
      kind: 'membership-grace',
      playerId: HOST_ID,
      connectionId: null,
      at: 1_000,
    },
  ];
  return snapshot;
}

function twoPlayerSnapshot(): RoomSnapshot {
  const snapshot = validSnapshot();
  const joined = decide(snapshot.room, {
    kind: 'client',
    playerId: OTHER_ID,
    at: 2,
    intent: { type: 'room/join', code: 'ABCD', playerName: 'Grace', playerId: OTHER_ID },
  });
  if (!joined.ok) throw new Error(joined.message);
  snapshot.room = joined.events.reduce(reduce, snapshot.room);
  snapshot.memberships[OTHER_ID] = {
    credentialDigest: DIGEST,
    activeConnectionId: OTHER_ATTEMPT_ID,
  };
  return snapshot;
}

function preparingSnapshot(): RoomSnapshot {
  const snapshot = validSnapshot();
  snapshot.room.phase = 'preparing';
  snapshot.roundPreparation = {
    token: PREPARATION_TOKEN,
    difficulty: 'curated',
    category: 'any',
    pair: null,
  };
  snapshot.deadlines = [
    {
      kind: 'round-preparation',
      token: PREPARATION_TOKEN,
      at: 1_000,
    },
  ];
  return snapshot;
}

function countdownSnapshot(): RoomSnapshot {
  const snapshot = preparingSnapshot();
  snapshot.room.phase = 'countdown';
  snapshot.room.countdownEndsAt = 11_000;
  snapshot.roundPreparation!.pair = {
    startArticle: 'Ada Lovelace',
    goalArticle: 'Analytical Engine',
  };
  snapshot.deadlines = [
    {
      kind: 'countdown',
      token: PREPARATION_TOKEN,
      at: 11_000,
    },
  ];
  return snapshot;
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
  snapshot.deadlines = [
    {
      kind: 'round-timeout',
      token: 'round:1:1000',
      at: 601_000,
    },
  ];
  return snapshot;
}

function resultsSnapshot(): RoomSnapshot {
  const snapshot = racingSnapshot();
  snapshot.room.phase = 'results';
  snapshot.room.roundsPlayed = 1;
  snapshot.deadlines = [];
  return snapshot;
}
