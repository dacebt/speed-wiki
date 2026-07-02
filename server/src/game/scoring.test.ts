import { describe, expect, test } from 'vitest';
import type { RoomEvent } from './events.js';
import { apply, client, seedPlayers, startRacing } from './harness.js';

function finishRank(events: RoomEvent[]): number | undefined {
  const finished = events.find((e) => e.type === 'PlayerFinished');
  return finished?.type === 'PlayerFinished' ? finished.rank : undefined;
}

describe('rank assignment', () => {
  test('draws the next rank from a counter that a departed finisher cannot reset', () => {
    const room = startRacing(seedPlayers('a', 'b'), { goal: 'Goal', at: 0 });
    const afterA = apply(room, client('a', { type: 'race/hop', article: 'Goal' }, 1000));
    expect(finishRank(afterA.events)).toBe(1);

    const withoutA = apply(afterA.room, {
      kind: 'sys/playerDisconnected',
      playerId: 'a',
      at: 1500,
    }).room;
    expect(withoutA.players.some((p) => p.id === 'a')).toBe(false);

    const afterB = apply(withoutA, client('b', { type: 'race/hop', article: 'Goal' }, 2000));
    expect(finishRank(afterB.events)).toBe(2);
  });
});

describe('round scoring', () => {
  test('awards points by finish rank, floors finishers past the table, and scores non-finishers zero', () => {
    const finishers = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
    let room = startRacing(seedPlayers(...finishers, 'quitter'), { goal: 'Goal', at: 0 });

    let at = 1000;
    for (const id of finishers) {
      room = apply(room, client(id, { type: 'race/hop', article: 'Goal' }, at)).room;
      at += 1000;
    }
    room = apply(room, client('quitter', { type: 'race/giveUp' }, at)).room;
    expect(room.phase).toBe('results');

    const scores = Object.fromEntries(room.players.map((p) => [p.id, p.score]));
    expect(scores).toEqual({ p1: 5, p2: 4, p3: 3, p4: 2, p5: 1, p6: 1, quitter: 0 });
  });

  test('leaves a non-finisher with zero round points', () => {
    let room = startRacing(seedPlayers('winner', 'quitter'), { goal: 'Goal', at: 0 });
    room = apply(room, client('winner', { type: 'race/hop', article: 'Goal' }, 1000)).room;
    room = apply(room, client('quitter', { type: 'race/giveUp' }, 2000)).room;

    const quitter = room.players.find((p) => p.id === 'quitter')!;
    expect(quitter.roundPoints).toBe(0);
  });
});
