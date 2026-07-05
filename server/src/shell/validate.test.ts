import { describe, expect, test } from 'vitest';
import { parseClientIntent } from './validate.js';

// Warrant: high-risk boundary logic. playerId is untrusted wire input that
// becomes a room map key and an event-log entry; the length contract is the
// only thing stopping an unbounded client string from being stored verbatim,
// and a regression here is invisible in the running app.
describe('playerId boundary contract', () => {
  test('accepts a create with a UUID-shaped playerId', () => {
    const intent = parseClientIntent({
      type: 'room/create',
      playerName: 'Ada',
      playerId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    });
    expect(intent).toMatchObject({
      type: 'room/create',
      playerId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    });
  });

  test('rejects a create whose playerId exceeds the length bound', () => {
    const intent = parseClientIntent({
      type: 'room/create',
      playerName: 'Ada',
      playerId: 'x'.repeat(65),
    });
    expect(intent).toBeNull();
  });

  test('rejects an empty playerId on join', () => {
    const intent = parseClientIntent({
      type: 'room/join',
      code: 'ROOM',
      playerName: 'Ada',
      playerId: '',
    });
    expect(intent).toBeNull();
  });
});
