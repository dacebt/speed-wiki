import { PLAYER_ROUND_HOP_LIMIT } from '@wikispeedrun/shared';
import { describe, expect, test } from 'vitest';
import { decide } from './decide.js';
import { reduce } from './reduce.js';
import { apply, client, seedPlayers, startRacing } from './harness.js';

describe('phase guards', () => {
  test('rejects start from a player who is not the host', () => {
    const room = seedPlayers('host', 'guest');
    const decision = decide(room, client('guest', { type: 'game/start' }));
    expect(decision).toMatchObject({ ok: false, code: 'not-host' });
  });

  test('rejects start once a race is already underway', () => {
    const room = startRacing(seedPlayers('host', 'guest'));
    const decision = decide(room, client('host', { type: 'game/start' }));
    expect(decision).toMatchObject({ ok: false, code: 'wrong-phase' });
  });

  test('rejects an intent from a player who is not in the room', () => {
    const room = seedPlayers('host');
    const decision = decide(room, client('stranger', { type: 'game/start' }));
    expect(decision).toMatchObject({ ok: false, code: 'not-in-room' });
  });

  test('rejects joining a room while a race is underway', () => {
    const room = startRacing(seedPlayers('host', 'guest'));
    const decision = decide(
      room,
      client('late', { type: 'room/join', code: 'ROOM', playerName: 'Late', playerId: 'late' }),
    );
    expect(decision).toMatchObject({ ok: false, code: 'wrong-phase' });
  });
});

describe('round end', () => {
  test('ends the round when the last racer reaches the goal', () => {
    const room = startRacing(seedPlayers('a', 'b'), { goal: 'Goal', at: 0 });
    const afterA = apply(room, client('a', { type: 'race/hop', article: 'Goal' }, 1000)).room;
    expect(afterA.phase).toBe('racing');
    const afterB = apply(afterA, client('b', { type: 'race/hop', article: 'Goal' }, 2000)).room;
    expect(afterB.phase).toBe('results');
  });

  test('ends the round when the last racer gives up', () => {
    const room = startRacing(seedPlayers('a', 'b'), { goal: 'Goal', at: 0 });
    const afterA = apply(room, client('a', { type: 'race/hop', article: 'Goal' }, 1000)).room;
    const afterB = apply(afterA, client('b', { type: 'race/giveUp' }, 2000)).room;
    expect(afterB.phase).toBe('results');
  });

  test('keeps racing while a racer is still on the board', () => {
    const room = startRacing(seedPlayers('a', 'b'), { goal: 'Goal', at: 0 });
    const afterA = apply(room, client('a', { type: 'race/giveUp' }, 1000)).room;
    expect(afterA.phase).toBe('racing');
  });
});

describe('per-Player round hop boundary', () => {
  test('accepts hop 100 and rejects hop 101 without changing state', () => {
    let room = startRacing(seedPlayers('solo'), { start: 'Start', goal: 'Goal', at: 0 });
    for (let hop = 1; hop < PLAYER_ROUND_HOP_LIMIT; hop += 1) {
      room = apply(room, client('solo', { type: 'race/hop', article: `Article ${hop}` }, hop)).room;
    }

    const hundredth = decide(
      room,
      client('solo', { type: 'race/hop', article: 'Article 100' }, 100),
    );
    expect(hundredth).toMatchObject({ ok: true });
    if (!hundredth.ok) throw new Error(hundredth.message);
    room = hundredth.events.reduce(reduce, room);
    expect(room.players[0]!.path).toHaveLength(PLAYER_ROUND_HOP_LIMIT + 1);

    const beforeRejected = JSON.stringify(room);
    const hundredAndFirst = decide(
      room,
      client('solo', { type: 'race/hop', article: 'Article 101' }, 101),
    );
    expect(hundredAndFirst).toMatchObject({ ok: false, code: 'hop-limit-reached' });
    expect(JSON.stringify(room)).toBe(beforeRejected);
  });

  test('does not permit a goal hop after the hop budget is exhausted', () => {
    let room = startRacing(seedPlayers('solo'), { start: 'Start', goal: 'Goal', at: 0 });
    for (let hop = 1; hop <= PLAYER_ROUND_HOP_LIMIT; hop += 1) {
      room = apply(room, client('solo', { type: 'race/hop', article: `Article ${hop}` }, hop)).room;
    }

    const beforeGoal = JSON.stringify(room);
    const goal = decide(room, client('solo', { type: 'race/hop', article: 'Goal' }, 101));
    expect(goal).toMatchObject({ ok: false, code: 'hop-limit-reached' });
    expect(JSON.stringify(room)).toBe(beforeGoal);
    expect(room.phase).toBe('racing');
  });
});

describe('round counting', () => {
  test('counts one completed round per round ended', () => {
    let room = startRacing(seedPlayers('solo'), { goal: 'Goal', at: 0 });
    room = apply(room, client('solo', { type: 'race/hop', article: 'Goal' }, 1000)).room;
    expect(room.roundsPlayed).toBe(1);

    room = apply(room, client('solo', { type: 'game/playAgain' }, 2000)).room;
    room = startRacing(room, { goal: 'Goal', at: 3000 });
    room = apply(room, client('solo', { type: 'race/hop', article: 'Goal' }, 4000)).room;
    expect(room.roundsPlayed).toBe(2);
  });
});

describe('round start', () => {
  test('resets the rank counter and per-player round state for the next round', () => {
    let room = startRacing(seedPlayers('a', 'b'), { start: 'Alpha', goal: 'Goal', at: 0 });
    room = apply(room, client('a', { type: 'race/hop', article: 'Goal' }, 1000)).room;
    room = apply(room, client('b', { type: 'race/giveUp' }, 2000)).room;
    expect(room.ranksAssigned).toBe(1);

    room = apply(room, client('a', { type: 'game/playAgain' }, 3000)).room;
    room = startRacing(room, { start: 'Beta', goal: 'Goal', at: 4000 });

    expect(room.ranksAssigned).toBe(0);
    for (const player of room.players) {
      expect(player).toMatchObject({
        path: ['Beta'],
        finishedRank: null,
        finishedAfterMs: null,
        gaveUp: false,
        roundPoints: 0,
      });
    }
  });
});

describe('host transfer on a player leaving', () => {
  test('promotes the first remaining player when the host leaves', () => {
    const room = seedPlayers('host', 'second', 'third');
    const after = reduce(room, { type: 'PlayerLeft', playerId: 'host', at: 0 });
    expect(after.players.map((p) => [p.id, p.isHost])).toEqual([
      ['second', true],
      ['third', false],
    ]);
  });

  test('leaves the host in place when a non-host leaves', () => {
    const room = seedPlayers('host', 'second', 'third');
    const after = reduce(room, { type: 'PlayerLeft', playerId: 'second', at: 0 });
    expect(after.players.map((p) => [p.id, p.isHost])).toEqual([
      ['host', true],
      ['third', false],
    ]);
  });
});

describe('room settings', () => {
  test('a host-set round length flows into the round deadline', () => {
    let room = seedPlayers('host', 'guest');
    room = apply(
      room,
      client('host', { type: 'room/setSettings', settings: { roundDurationMs: 3 * 60_000 } }),
    ).room;
    expect(room.settings.roundDurationMs).toBe(3 * 60_000);
    room = startRacing(room, { at: 0 });
    expect(room.round!.deadline - room.round!.startedAt).toBe(3 * 60_000);
  });

  test('merges a partial patch without clobbering the other knob', () => {
    let room = seedPlayers('host');
    room = apply(
      room,
      client('host', { type: 'room/setSettings', settings: { roundDurationMs: 5 * 60_000 } }),
    ).room;
    room = apply(
      room,
      client('host', { type: 'room/setSettings', settings: { countdownMs: 5_000 } }),
    ).room;
    expect(room.settings).toEqual({
      roundDurationMs: 5 * 60_000,
      countdownMs: 5_000,
      difficulty: 'curated',
      category: 'any',
    });
  });

  test('rejects out-of-range settings instead of clamping', () => {
    const room = seedPlayers('host');
    const decision = decide(
      room,
      client('host', { type: 'room/setSettings', settings: { countdownMs: 60_000 } }),
    );
    expect(decision).toMatchObject({ ok: false, code: 'invalid-settings' });
  });

  test('rejects a settings change from a non-host', () => {
    const room = seedPlayers('host', 'guest');
    const decision = decide(
      room,
      client('guest', { type: 'room/setSettings', settings: { countdownMs: 5_000 } }),
    );
    expect(decision).toMatchObject({ ok: false, code: 'not-host' });
  });
});

describe('round preparation', () => {
  test('the chosen difficulty is carried into article selection', () => {
    let room = seedPlayers('host');
    room = apply(
      room,
      client('host', { type: 'room/setSettings', settings: { difficulty: 'random' } }),
    ).room;
    const { events } = apply(room, client('host', { type: 'game/start' }, 0));
    expect(events.find((e) => e.type === 'RoundPreparationStarted')).toMatchObject({
      difficulty: 'random',
    });
  });

  test('the chosen category is carried into article selection', () => {
    let room = seedPlayers('host');
    room = apply(
      room,
      client('host', { type: 'room/setSettings', settings: { category: 'history' } }),
    ).room;
    const { events } = apply(room, client('host', { type: 'game/start' }, 0));
    expect(events.find((e) => e.type === 'RoundPreparationStarted')).toMatchObject({
      category: 'history',
    });
  });

  test('successful preparation begins the countdown with the selected pair', () => {
    let room = apply(seedPlayers('host'), client('host', { type: 'game/start' }, 0)).room;
    const prepared = apply(room, {
      kind: 'sys/roundPrepared',
      startArticle: 'Ada Lovelace',
      goalArticle: 'Analytical Engine',
      at: 100,
    });
    room = prepared.room;
    expect(room.phase).toBe('countdown');
    expect(prepared.events).toEqual([
      expect.objectContaining({
        type: 'CountdownStarted',
        startArticle: 'Ada Lovelace',
        goalArticle: 'Analytical Engine',
      }),
    ]);
  });

  test('failed preparation returns to the lobby without a round', () => {
    let room = apply(seedPlayers('host'), client('host', { type: 'game/start' }, 0)).room;
    expect(room.phase).toBe('preparing');
    room = apply(room, { kind: 'sys/roundStartFailed', at: 1000 }).room;
    expect(room.phase).toBe('lobby');
    expect(room.round).toBeNull();
  });

  test('duplicate preparation and countdown transitions are no-ops', () => {
    let room = apply(seedPlayers('host'), client('host', { type: 'game/start' }, 0)).room;
    room = apply(room, {
      kind: 'sys/roundPrepared',
      startArticle: 'Start',
      goalArticle: 'Goal',
      at: 100,
    }).room;
    expect(
      decide(room, {
        kind: 'sys/roundPrepared',
        startArticle: 'Other',
        goalArticle: 'Elsewhere',
        at: 200,
      }),
    ).toEqual({ ok: true, events: [] });
    room = apply(room, {
      kind: 'sys/countdownFinished',
      startArticle: 'Start',
      goalArticle: 'Goal',
      at: 10_100,
    }).room;
    expect(
      decide(room, {
        kind: 'sys/countdownFinished',
        startArticle: 'Start',
        goalArticle: 'Goal',
        at: 10_200,
      }),
    ).toEqual({ ok: true, events: [] });
  });
});

describe('away racer round end', () => {
  test('holds the round while a racer is away, then ends it when the grace window removes them', () => {
    const room = startRacing(seedPlayers('a', 'b'), { goal: 'Goal', at: 0 });
    const aWon = apply(room, client('a', { type: 'race/hop', article: 'Goal' }, 1000)).room;
    // b drops mid-race: marked away, slot held — the round must not end early.
    const bAway = apply(aWon, { kind: 'sys/playerAway', playerId: 'b', at: 1500 }).room;
    expect(bAway.phase).toBe('racing');
    expect(bAway.players.find((p) => p.id === 'b')?.away).toBe(true);
    // b never rejoins; the grace window lapses and removes them, ending the round.
    const ended = apply(bAway, { kind: 'sys/playerLeft', playerId: 'b', at: 47_000 }).room;
    expect(ended.phase).toBe('results');
  });

  test('a rejoining away racer is no longer away and keeps their in-progress path', () => {
    const room = startRacing(seedPlayers('a', 'b'), { start: 'Start', goal: 'Goal', at: 0 });
    const moved = apply(room, client('a', { type: 'race/hop', article: 'Mid' }, 500)).room;
    const away = apply(moved, { kind: 'sys/playerAway', playerId: 'a', at: 800 }).room;
    const back = apply(
      away,
      client('a', { type: 'room/join', code: 'ROOM', playerName: 'a', playerId: 'a' }, 1000),
    ).room;
    const a = back.players.find((p) => p.id === 'a')!;
    expect(a.away).toBe(false);
    expect(a.path).toEqual(['Start', 'Mid']);
    expect(back.phase).toBe('racing');
  });
});
