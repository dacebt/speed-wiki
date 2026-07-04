import { describe, expect, test } from 'vitest';
import { decide } from './decide.js';
import { reduce } from './reduce.js';
import { apply, client, seedPlayers, startRacing } from './harness.js';

describe('phase guards', () => {
  test('rejects start from a player who is not the host', () => {
    const room = seedPlayers('host', 'guest');
    const decision = decide(room, client('guest', { type: 'game/start', hardMode: false }));
    expect(decision).toMatchObject({ ok: false, code: 'not-host' });
  });

  test('rejects start once a race is already underway', () => {
    const room = startRacing(seedPlayers('host', 'guest'));
    const decision = decide(room, client('host', { type: 'game/start', hardMode: false }));
    expect(decision).toMatchObject({ ok: false, code: 'wrong-phase' });
  });

  test('rejects an intent from a player who is not in the room', () => {
    const room = seedPlayers('host');
    const decision = decide(room, client('stranger', { type: 'game/start', hardMode: false }));
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
