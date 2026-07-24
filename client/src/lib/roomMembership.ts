import { normalizeRoomCode } from '@wikispeedrun/shared';
import type { RoomMembership } from './transportTypes.js';

export type StoredMembershipResult =
  | { ok: true; membership: RoomMembership }
  | { ok: false; reason: 'missing' | 'invalid' | 'storage-failed' };

export function membershipStorageKey(roomCode: string): string {
  return `wikispeedrun.room.${roomCode}.membership`;
}

export function parseRoomMembership(value: unknown, roomCode: string): RoomMembership | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const normalizedCode = normalizeRoomCode(roomCode);
  return normalizedCode !== null &&
    normalizedCode === roomCode &&
    Object.keys(record).length === 2 &&
    typeof record.playerId === 'string' &&
    isUuid(record.playerId) &&
    typeof record.rejoinCredential === 'string' &&
    /^[A-Za-z0-9_-]{43}$/.test(record.rejoinCredential)
    ? {
        roomCode,
        playerId: record.playerId,
        rejoinCredential: record.rejoinCredential,
      }
    : null;
}

export function loadRoomMembership(roomCode: string): StoredMembershipResult {
  let raw: string | null;
  try {
    raw = localStorage.getItem(membershipStorageKey(roomCode));
  } catch {
    return { ok: false, reason: 'storage-failed' };
  }
  if (raw === null) return { ok: false, reason: 'missing' };
  try {
    const membership = parseRoomMembership(JSON.parse(raw), roomCode);
    return membership ? { ok: true, membership } : { ok: false, reason: 'invalid' };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}

export function persistRoomMembership(membership: RoomMembership): void {
  localStorage.setItem(
    membershipStorageKey(membership.roomCode),
    JSON.stringify({
      playerId: membership.playerId,
      rejoinCredential: membership.rejoinCredential,
    }),
  );
}

export function deleteRoomMembership(roomCode: string): void {
  localStorage.removeItem(membershipStorageKey(roomCode));
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
