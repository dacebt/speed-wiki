import { MEMBERSHIP_MESSAGE_RATE_LIMIT, type ErrorCode } from '@wikispeedrun/shared';
import {
  ROOM_STORAGE_KEY,
  parseRoomSnapshot,
  type MembershipMessageWindow,
  type RoomSnapshot,
} from './snapshot.js';

type MessageClaim =
  { ok: true; snapshot: RoomSnapshot } | { ok: false; code: ErrorCode; message: string };

export function initialMessageWindow(): MembershipMessageWindow {
  return { startedAt: 0, count: 0 };
}

export function advanceMessageWindow(
  window: MembershipMessageWindow,
  at: number,
): MembershipMessageWindow | null {
  if (window.count === 0 || at >= window.startedAt + MEMBERSHIP_MESSAGE_RATE_LIMIT.windowMs) {
    return { startedAt: at, count: 1 };
  }
  return window.count < MEMBERSHIP_MESSAGE_RATE_LIMIT.messages
    ? { ...window, count: window.count + 1 }
    : null;
}

export function claimAuthenticatedMessage(
  snapshot: RoomSnapshot,
  playerId: string,
  connectionId: string,
  at: number,
): MessageClaim {
  const membership = snapshot.memberships[playerId];
  if (!membership) {
    return {
      ok: false,
      code: 'invalid-membership',
      message: 'The Room Membership is invalid.',
    };
  }
  if (membership.activeConnectionId !== connectionId) {
    return {
      ok: false,
      code: 'connection-replaced',
      message: 'This Room Membership was opened in another tab.',
    };
  }
  const messageWindow = advanceMessageWindow(membership.messageWindow, at);
  if (!messageWindow) {
    return {
      ok: false,
      code: 'rate-limited',
      message: 'This Room Membership sent too many messages. Try again shortly.',
    };
  }
  return {
    ok: true,
    snapshot: {
      ...snapshot,
      memberships: {
        ...snapshot.memberships,
        [playerId]: { ...membership, messageWindow },
      },
    },
  };
}

export async function consumeAuthenticatedMessage(
  state: DurableObjectState,
  playerId: string,
  connectionId: string,
): Promise<MessageClaim> {
  return state.storage.transaction(async (transaction): Promise<MessageClaim> => {
    const stored = await transaction.get(ROOM_STORAGE_KEY);
    if (stored === undefined) {
      return { ok: false, code: 'room-not-found', message: 'No room found with that code.' };
    }
    const claim = claimAuthenticatedMessage(
      parseRoomSnapshot(stored),
      playerId,
      connectionId,
      Date.now(),
    );
    if (!claim.ok) return claim;
    await transaction.put(ROOM_STORAGE_KEY, claim.snapshot);
    return claim;
  });
}
