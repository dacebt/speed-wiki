import { describe, expect, test } from 'vitest';
import { closeFailure } from './transportHelpers.js';

describe('Worker WebSocket close fallback', () => {
  test.each([
    [1008, 'rate-limited', 'This Room Membership sent too many messages. Try again shortly.'],
    [1009, 'message-too-large', 'Room messages may be at most 4,096 UTF-8 bytes.'],
  ] as const)('maps close code %s to %s', (closeCode, code, message) => {
    expect(closeFailure({ code: closeCode } as CloseEvent)).toMatchObject({ code, message });
  });
});
