import { describe, expect, test } from 'vitest';
import { readInviteCode } from './inviteCode.js';

describe('invite Room code parsing', () => {
  test('preserves an overlong code for rejection instead of truncating it into another Room', () => {
    expect(readInviteCode('?code=ABCDX')).toBe('ABCDX');
  });

  test('normalizes case and surrounding whitespace without changing length', () => {
    expect(readInviteCode('?code=%20ab2d%20')).toBe('AB2D');
  });
});
