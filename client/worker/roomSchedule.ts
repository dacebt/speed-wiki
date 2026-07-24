export type PhaseDeadline =
  | { kind: 'round-preparation'; token: string; at: number }
  | { kind: 'countdown'; token: string; at: number }
  | { kind: 'round-timeout'; token: string; at: number };

export interface MembershipGraceDeadline {
  kind: 'membership-grace';
  playerId: string;
  connectionId: string | null;
  at: number;
}

export type RoomDeadline = PhaseDeadline | MembershipGraceDeadline;
export const MEMBERSHIP_GRACE_MS = 45_000;

interface AlarmStorage {
  setAlarm(scheduledTime: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export function phaseDeadline(deadlines: readonly RoomDeadline[]): PhaseDeadline | null {
  return deadlines.find((deadline): deadline is PhaseDeadline => isPhaseDeadline(deadline)) ?? null;
}

export function replacePhaseDeadline(
  deadlines: readonly RoomDeadline[],
  replacement: PhaseDeadline | null,
): RoomDeadline[] {
  const grace = deadlines.filter((deadline) => !isPhaseDeadline(deadline));
  return replacement ? [...grace, replacement] : grace;
}

export function upsertMembershipGrace(
  deadlines: readonly RoomDeadline[],
  grace: MembershipGraceDeadline,
): RoomDeadline[] {
  return [
    ...deadlines.filter(
      (deadline) => deadline.kind !== 'membership-grace' || deadline.playerId !== grace.playerId,
    ),
    grace,
  ];
}

export function removeMembershipGrace(
  deadlines: readonly RoomDeadline[],
  playerId: string,
): RoomDeadline[] {
  return deadlines.filter(
    (deadline) => deadline.kind !== 'membership-grace' || deadline.playerId !== playerId,
  );
}

export function nextDeadline(deadlines: readonly RoomDeadline[]): RoomDeadline | null {
  return deadlines.length === 0 ? null : [...deadlines].sort(compareDeadlines)[0]!;
}

function compareDeadlines(left: RoomDeadline, right: RoomDeadline): number {
  if (left.at !== right.at) return left.at - right.at;
  const leftPriority = left.kind === 'membership-grace' ? 0 : 1;
  const rightPriority = right.kind === 'membership-grace' ? 0 : 1;
  if (leftPriority !== rightPriority) return leftPriority - rightPriority;
  return deadlineIdentity(left).localeCompare(deadlineIdentity(right));
}

export async function syncAlarm(
  storage: AlarmStorage,
  deadlines: readonly RoomDeadline[],
): Promise<void> {
  const next = nextDeadline(deadlines);
  if (next) await storage.setAlarm(next.at);
  else await storage.deleteAlarm();
}

export function sameDeadline(left: RoomDeadline, right: RoomDeadline): boolean {
  return deadlineIdentity(left) === deadlineIdentity(right) && left.at === right.at;
}

function isPhaseDeadline(deadline: RoomDeadline): deadline is PhaseDeadline {
  return deadline.kind !== 'membership-grace';
}

function deadlineIdentity(deadline: RoomDeadline): string {
  return deadline.kind === 'membership-grace'
    ? `${deadline.kind}:${deadline.playerId}:${deadline.connectionId ?? 'initial'}`
    : `${deadline.kind}:${deadline.token}`;
}
