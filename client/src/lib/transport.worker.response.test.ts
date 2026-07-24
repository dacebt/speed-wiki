import { describe, expect, test } from 'vitest';
import { parseCreateRoomResponse } from './transport.worker.js';
import { CREDENTIAL, PLAYER_ID } from './transport.worker.fixtures.js';

describe('Worker creation response validation', () => {
  const valid = {
    roomCode: 'ABCD',
    playerId: PLAYER_ID,
    rejoinCredential: CREDENTIAL,
  };

  test('accepts the authority-issued response shape', () => {
    expect(parseCreateRoomResponse(valid)).toEqual(valid);
  });

  test.each([
    ['unnormalized Room code', { ...valid, roomCode: 'abcd' }],
    ['invalid Room code alphabet', { ...valid, roomCode: 'ABCI' }],
    ['empty Player ID', { ...valid, playerId: '' }],
    ['non-UUID Player ID', { ...valid, playerId: 'player-1' }],
    ['short credential', { ...valid, rejoinCredential: 'secret' }],
    ['non-base64url credential', { ...valid, rejoinCredential: `${'A'.repeat(42)}+` }],
    ['extra field', { ...valid, extra: true }],
  ])('rejects %s', (_label, value) => {
    expect(parseCreateRoomResponse(value)).toBeNull();
  });
});
