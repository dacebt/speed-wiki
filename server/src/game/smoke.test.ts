import { expect, test } from 'vitest';
import { decide } from './decide.js';
import { initialRoom } from './state.js';

test('resolves the core through workspace imports', () => {
  const room = initialRoom('ABCD');
  const decision = decide(room, {
    kind: 'client',
    playerId: 'p1',
    at: 0,
    intent: { type: 'room/create', playerName: 'Ada' },
  });
  expect(decision.ok).toBe(true);
});
