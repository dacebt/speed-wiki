import { describe, expect, test, vi } from 'vitest';
import {
  parseAttachment,
  parseAuthenticatedMessage,
  parseConnectMessage,
  rejectSocket,
} from './roomConnection.js';

const PLAYER_ID = '1f6f49f6-30d5-4fb7-bab8-d015bf878fe8';
const CONNECTION_ID = '318f1f21-9fd8-4c8a-a639-0f6d40ceefab';
const CREDENTIAL = 'A'.repeat(43);

describe('Room Connection exact validation', () => {
  test('accepts only exact pending and authenticated attachments', () => {
    expect(parseAttachment({ state: 'pending' })).toEqual({ state: 'pending' });
    expect(
      parseAttachment({
        state: 'authenticated',
        playerId: PLAYER_ID,
        connectionId: CONNECTION_ID,
      }),
    ).toEqual({
      state: 'authenticated',
      playerId: PLAYER_ID,
      connectionId: CONNECTION_ID,
    });
    expect(parseAttachment({ state: 'pending', extra: true })).toBeNull();
    expect(
      parseAttachment({
        state: 'authenticated',
        playerId: PLAYER_ID,
        connectionId: CONNECTION_ID,
        extra: true,
      }),
    ).toBeNull();
    expect(parseAttachment({ state: 'authenticated', playerId: PLAYER_ID })).toBeNull();
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

  test('accepts only exact supported intents after authentication', () => {
    expect(parseAuthenticatedMessage(JSON.stringify({ type: 'game/start' }))).toEqual({
      type: 'game/start',
    });
    expect(
      parseAuthenticatedMessage(JSON.stringify({ type: 'race/hop', article: 'Ada Lovelace' })),
    ).toEqual({ type: 'race/hop', article: 'Ada Lovelace' });
    expect(parseAuthenticatedMessage(JSON.stringify({ type: 'race/giveUp' }))).toEqual({
      type: 'race/giveUp',
    });
    expect(parseAuthenticatedMessage(JSON.stringify({ type: 'game/playAgain' }))).toEqual({
      type: 'game/playAgain',
    });
    expect(parseAuthenticatedMessage(JSON.stringify({ type: 'game/start', extra: true }))).toBe(
      'invalid',
    );
    expect(parseAuthenticatedMessage(JSON.stringify({ type: 'race/hop' }))).toBe('invalid');
    expect(parseAuthenticatedMessage(JSON.stringify({ type: 'race/hop', article: '' }))).toBe(
      'invalid',
    );
    expect(
      parseAuthenticatedMessage(JSON.stringify({ type: 'race/hop', article: ' Ada Lovelace' })),
    ).toBe('invalid');
    expect(
      parseAuthenticatedMessage(JSON.stringify({ type: 'race/hop', article: 'Ada Lovelace ' })),
    ).toBe('invalid');
    expect(
      parseAuthenticatedMessage(
        JSON.stringify({ type: 'race/hop', article: 'Ada Lovelace', extra: true }),
      ),
    ).toBe('invalid');
    expect(parseAuthenticatedMessage(JSON.stringify({ type: 'race/giveUp', extra: true }))).toBe(
      'invalid',
    );
    expect(parseAuthenticatedMessage(JSON.stringify({ type: 'game/playAgain', extra: true }))).toBe(
      'invalid',
    );
    expect(
      parseAuthenticatedMessage(JSON.stringify({ type: 'room/kick', playerId: PLAYER_ID })),
    ).toEqual({ type: 'room/kick', playerId: PLAYER_ID });
    expect(parseAuthenticatedMessage(JSON.stringify({ type: 'room/kick' }))).toBe('invalid');
    expect(
      parseAuthenticatedMessage(
        JSON.stringify({ type: 'room/kick', playerId: PLAYER_ID, extra: true }),
      ),
    ).toBe('invalid');
    expect(parseAuthenticatedMessage(JSON.stringify({ type: 'room/setSettings' }))).toBe(
      'unsupported',
    );
    expect(parseAuthenticatedMessage(new ArrayBuffer(0))).toBe('invalid');
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
