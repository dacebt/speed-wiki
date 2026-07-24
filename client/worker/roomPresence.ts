import { decide, reduce } from '@wikispeedrun/game';
import type { ErrorCode } from '@wikispeedrun/shared';
import {
  removeMembershipGrace,
  replacePhaseDeadline,
  sameDeadline,
  syncAlarm,
  upsertMembershipGrace,
  MEMBERSHIP_GRACE_MS,
  type MembershipGraceDeadline,
} from './roomSchedule.js';
import { claimAuthenticatedMessage } from './roomRateLimit.js';
import { ROOM_STORAGE_KEY, parseRoomSnapshot, type RoomSnapshot } from './snapshot.js';

export type PresenceResult =
  { kind: 'none' } | { kind: 'deleted' } | { kind: 'sync'; snapshot: RoomSnapshot };

export type KickResult =
  | { kind: 'sync'; snapshot: RoomSnapshot; connectionId: string | null }
  | { kind: 'error'; code: ErrorCode; message: string };

export async function disconnectMembership(
  state: DurableObjectState,
  playerId: string,
  connectionId: string,
): Promise<PresenceResult> {
  const at = Date.now();
  return state.storage.transaction(async (transaction): Promise<PresenceResult> => {
    const stored = await transaction.get(ROOM_STORAGE_KEY);
    if (stored === undefined) return { kind: 'none' };
    const current = parseRoomSnapshot(stored);
    const membership = current.memberships[playerId];
    if (membership?.activeConnectionId !== connectionId) return { kind: 'none' };
    const decision = decide(current.room, { kind: 'sys/playerAway', playerId, at });
    if (!decision.ok || decision.events.length === 0) return { kind: 'none' };
    const deadlines = upsertMembershipGrace(current.deadlines, {
      kind: 'membership-grace',
      playerId,
      connectionId,
      at: at + MEMBERSHIP_GRACE_MS,
    });
    const next: RoomSnapshot = {
      ...current,
      room: decision.events.reduce(reduce, current.room),
      memberships: {
        ...current.memberships,
        [playerId]: { ...membership, activeConnectionId: null },
      },
      deadlines,
    };
    parseRoomSnapshot(next);
    await transaction.put(ROOM_STORAGE_KEY, next);
    await syncAlarm(transaction, deadlines);
    return { kind: 'sync', snapshot: next };
  });
}

export async function expireMembershipGrace(
  state: DurableObjectState,
  due: MembershipGraceDeadline,
): Promise<PresenceResult> {
  return state.storage.transaction(async (transaction): Promise<PresenceResult> => {
    const stored = await transaction.get(ROOM_STORAGE_KEY);
    if (stored === undefined) return { kind: 'none' };
    const current = parseRoomSnapshot(stored);
    const persisted = current.deadlines.find(
      (deadline): deadline is MembershipGraceDeadline =>
        deadline.kind === 'membership-grace' && deadline.playerId === due.playerId,
    );
    const membership = current.memberships[due.playerId];
    if (
      !persisted ||
      !sameDeadline(persisted, due) ||
      membership?.activeConnectionId !== null ||
      !current.room.players.some((player) => player.id === due.playerId && player.away)
    ) {
      return { kind: 'none' };
    }
    if (Object.keys(current.memberships).length === 1) {
      await transaction.delete(ROOM_STORAGE_KEY);
      await transaction.deleteAlarm();
      return { kind: 'deleted' };
    }

    const decision = decide(current.room, {
      kind: 'sys/playerLeft',
      playerId: due.playerId,
      at: Date.now(),
    });
    if (!decision.ok || decision.events.length === 0) return { kind: 'none' };
    const room = decision.events.reduce(reduce, current.room);
    const memberships = { ...current.memberships };
    delete memberships[due.playerId];
    const joinAttempts = Object.fromEntries(
      Object.entries(current.joinAttempts).filter(
        ([, attempt]) => attempt.playerId !== due.playerId,
      ),
    );
    let deadlines = removeMembershipGrace(current.deadlines, due.playerId);
    if (room.phase !== current.room.phase) deadlines = replacePhaseDeadline(deadlines, null);
    const next: RoomSnapshot = {
      ...current,
      room,
      memberships,
      joinAttempts,
      deadlines,
    };
    parseRoomSnapshot(next);
    await transaction.put(ROOM_STORAGE_KEY, next);
    await syncAlarm(transaction, deadlines);
    return { kind: 'sync', snapshot: next };
  });
}

export async function kickMembership(
  state: DurableObjectState,
  actorId: string,
  actorConnectionId: string,
  targetId: string,
): Promise<KickResult> {
  const at = Date.now();
  return state.storage.transaction(async (transaction): Promise<KickResult> => {
    const stored = await transaction.get(ROOM_STORAGE_KEY);
    if (stored === undefined) {
      return { kind: 'error', code: 'room-not-found', message: 'No room found with that code.' };
    }
    const claim = claimAuthenticatedMessage(
      parseRoomSnapshot(stored),
      actorId,
      actorConnectionId,
      at,
    );
    if (!claim.ok) return { kind: 'error', code: claim.code, message: claim.message };
    const current = claim.snapshot;
    const decision = decide(current.room, {
      kind: 'client',
      playerId: actorId,
      at,
      intent: { type: 'room/kick', playerId: targetId },
    });
    if (!decision.ok) {
      await transaction.put(ROOM_STORAGE_KEY, current);
      return { kind: 'error', code: decision.code, message: decision.message };
    }
    const membership = current.memberships[targetId];
    if (!membership || decision.events.length === 0) {
      await transaction.put(ROOM_STORAGE_KEY, current);
      return { kind: 'error', code: 'not-in-room', message: 'No such player to remove.' };
    }
    const room = decision.events.reduce(reduce, current.room);
    const memberships = { ...current.memberships };
    delete memberships[targetId];
    const joinAttempts = Object.fromEntries(
      Object.entries(current.joinAttempts).filter(([, attempt]) => attempt.playerId !== targetId),
    );
    const deadlines = removeMembershipGrace(current.deadlines, targetId);
    const next: RoomSnapshot = {
      ...current,
      room,
      memberships,
      joinAttempts,
      deadlines,
    };
    parseRoomSnapshot(next);
    await transaction.put(ROOM_STORAGE_KEY, next);
    await syncAlarm(transaction, deadlines);
    return {
      kind: 'sync',
      snapshot: next,
      connectionId: membership.activeConnectionId,
    };
  });
}
