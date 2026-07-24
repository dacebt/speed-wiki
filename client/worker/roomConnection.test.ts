import { describe, expect, test, vi } from 'vitest';
import { parseAttachment, parseConnectMessage, rejectSocket } from './roomConnection.js';

const PLAYER_ID = '1f6f49f6-30d5-4fb7-bab8-d015bf878fe8';
const CREDENTIAL = 'A'.repeat(43);

describe('Room Connection exact validation', () => {
  test('accepts only exact pending and authenticated attachments', () => {
    expect(parseAttachment({ state: 'pending' })).toEqual({ state: 'pending' });
    expect(parseAttachment({ state: 'authenticated', playerId: PLAYER_ID })).toEqual({
      state: 'authenticated',
      playerId: PLAYER_ID,
    });
    expect(parseAttachment({ state: 'pending', extra: true })).toBeNull();
    expect(
      parseAttachment({ state: 'authenticated', playerId: PLAYER_ID, extra: true }),
    ).toBeNull();
    expect(parseAttachment({ state: 'authenticated', playerId: 'public-id' })).toBeNull();
  });

  test('accepts only the exact authentication frame and credential formats', () => {
    const valid = {
      type: 'room/connect',
      playerId: PLAYER_ID,
      rejoinCredential: CREDENTIAL,
    };
    expect(parseConnectMessage(JSON.stringify(valid))).toEqual(valid);
    expect(parseConnectMessage(JSON.stringify({ ...valid, extra: true }))).toBeNull();
    expect(parseConnectMessage(JSON.stringify({ ...valid, playerId: 'public-id' }))).toBeNull();
    expect(
      parseConnectMessage(JSON.stringify({ ...valid, rejoinCredential: 'not-a-credential' })),
    ).toBeNull();
  });

  test('reject closes a socket even when the structured error cannot be sent', () => {
    const close = vi.fn();
    const socket = {
      send: () => {
        throw new Error('stale socket');
      },
      close,
    };
    rejectSocket(socket, 'invalid-membership', 'Invalid.', 4003);
    expect(close).toHaveBeenCalledWith(4003, 'Invalid.');
  });
});
