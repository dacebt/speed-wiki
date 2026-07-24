import { beforeEach, describe, expect, test, vi } from 'vitest';
import { loadRoomMembership, membershipStorageKey, parseRoomMembership } from './roomMembership.js';
import { CREDENTIAL, PLAYER_ID } from './transport.worker.fixtures.js';

describe('Room-scoped Membership storage', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', { getItem: vi.fn() });
  });

  test('accepts the exact stored Membership shape for its Room', () => {
    expect(
      parseRoomMembership({ playerId: PLAYER_ID, rejoinCredential: CREDENTIAL }, 'ABCD'),
    ).toEqual({
      roomCode: 'ABCD',
      playerId: PLAYER_ID,
      rejoinCredential: CREDENTIAL,
    });
  });

  test.each([
    ['extra key', { playerId: PLAYER_ID, rejoinCredential: CREDENTIAL, extra: true }],
    ['invalid Player ID', { playerId: 'public-id', rejoinCredential: CREDENTIAL }],
    ['invalid credential', { playerId: PLAYER_ID, rejoinCredential: 'secret' }],
  ])('rejects %s', (_label, value) => {
    expect(parseRoomMembership(value, 'ABCD')).toBeNull();
  });

  test('reports malformed persisted JSON without throwing', () => {
    vi.mocked(localStorage.getItem).mockReturnValue('{');
    expect(loadRoomMembership('ABCD')).toEqual({ ok: false, reason: 'invalid' });
    expect(localStorage.getItem).toHaveBeenCalledWith(membershipStorageKey('ABCD'));
  });
});
