import { describe, expect, test, vi } from 'vitest';
import {
  nextDeadline,
  removeMembershipGrace,
  syncAlarm,
  type RoomDeadline,
} from './roomSchedule.js';

const FIRST_PLAYER = '1f6f49f6-30d5-4fb7-bab8-d015bf878fe8';
const SECOND_PLAYER = 'c61ecdb5-0476-4503-953b-04567336f436';
const FIRST_CONNECTION = '318f1f21-9fd8-4c8a-a639-0f6d40ceefab';
const SECOND_CONNECTION = '418f1f21-9fd8-4c8a-a639-0f6d40ceefab';

describe('Room deadline schedule', () => {
  test('orders simultaneous grace deadlines by Player and before a phase transition', () => {
    const deadlines: RoomDeadline[] = [
      { kind: 'round-preparation', token: 'phase', at: 10_000 },
      {
        kind: 'membership-grace',
        playerId: SECOND_PLAYER,
        connectionId: SECOND_CONNECTION,
        at: 10_000,
      },
      {
        kind: 'membership-grace',
        playerId: FIRST_PLAYER,
        connectionId: FIRST_CONNECTION,
        at: 10_000,
      },
    ];

    expect(nextDeadline(deadlines)).toEqual(deadlines[2]);
    const afterFirst = removeMembershipGrace(deadlines, FIRST_PLAYER);
    expect(nextDeadline(afterFirst)).toEqual(deadlines[1]);
    const afterSecond = removeMembershipGrace(afterFirst, SECOND_PLAYER);
    expect(nextDeadline(afterSecond)).toEqual(deadlines[0]);
  });

  test('arms only the earliest deadline and deletes an empty schedule alarm', async () => {
    const storage = {
      setAlarm: vi.fn().mockResolvedValue(undefined),
      deleteAlarm: vi.fn().mockResolvedValue(undefined),
    };
    const deadlines: RoomDeadline[] = [
      { kind: 'round-preparation', token: 'later', at: 20_000 },
      {
        kind: 'membership-grace',
        playerId: FIRST_PLAYER,
        connectionId: FIRST_CONNECTION,
        at: 10_000,
      },
    ];

    await syncAlarm(storage, deadlines);
    expect(storage.setAlarm).toHaveBeenCalledOnce();
    expect(storage.setAlarm).toHaveBeenCalledWith(10_000);
    expect(storage.deleteAlarm).not.toHaveBeenCalled();

    await syncAlarm(storage, []);
    expect(storage.deleteAlarm).toHaveBeenCalledOnce();
  });
});
