import type { CorePlayer, CoreRoom } from '@wikispeedrun/game';
import { phaseDeadline, type MembershipGraceDeadline, type RoomDeadline } from './roomSchedule.js';
import {
  CATEGORIES,
  DIFFICULTIES,
  MAX_NAME_LENGTH,
  ROOM_PHASES,
  isRoomSettingsInRange,
  isValidCosmetics,
  normalizeRoomCode,
  type Category,
  type Difficulty,
  type RoomSettings,
  type RoundView,
} from '@wikispeedrun/shared';

export const ROOM_SNAPSHOT_VERSION = 5;
export const ROOM_STORAGE_KEY = 'room';

interface Membership {
  credentialDigest: string;
  activeConnectionId: string | null;
}

type JoinAttempt =
  | {
      state: 'pending';
      playerId: string;
      playerName: string;
      credentialDigest: string;
      generation: number;
    }
  | {
      state: 'promoted';
      playerId: string;
    };

interface PreparedArticlePair {
  startArticle: string;
  goalArticle: string;
}

interface RoundPreparation {
  token: string;
  difficulty: Difficulty;
  category: Category;
  pair: PreparedArticlePair | null;
}

export interface RoomSnapshot {
  schemaVersion: typeof ROOM_SNAPSHOT_VERSION;
  room: CoreRoom;
  memberships: Record<string, Membership>;
  joinAttempts: Record<string, JoinAttempt>;
  roundPreparation: RoundPreparation | null;
  deadlines: RoomDeadline[];
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: UnknownRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNullableNonNegativeInteger(value: unknown): value is number | null {
  return value === null || isNonNegativeInteger(value);
}

function isNullablePositiveInteger(value: unknown): value is number | null {
  return value === null || isPositiveInteger(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string' && item.trim().length > 0)
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseSettings(value: unknown): RoomSettings | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['roundDurationMs', 'countdownMs', 'difficulty', 'category']) ||
    !isPositiveInteger(value.roundDurationMs) ||
    !isPositiveInteger(value.countdownMs) ||
    typeof value.difficulty !== 'string' ||
    !(DIFFICULTIES as readonly string[]).includes(value.difficulty) ||
    typeof value.category !== 'string' ||
    !(CATEGORIES as readonly string[]).includes(value.category)
  ) {
    return null;
  }
  const settings: RoomSettings = {
    roundDurationMs: value.roundDurationMs,
    countdownMs: value.countdownMs,
    difficulty: value.difficulty as RoomSettings['difficulty'],
    category: value.category as RoomSettings['category'],
  };
  return isRoomSettingsInRange(settings) ? settings : null;
}

function parseRound(value: unknown): RoundView | null | undefined {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['roundNumber', 'startArticle', 'goalArticle', 'startedAt', 'deadline']) ||
    !isPositiveInteger(value.roundNumber) ||
    typeof value.startArticle !== 'string' ||
    value.startArticle.trim().length === 0 ||
    value.startArticle !== value.startArticle.trim() ||
    typeof value.goalArticle !== 'string' ||
    value.goalArticle.trim().length === 0 ||
    value.goalArticle !== value.goalArticle.trim() ||
    !isNonNegativeInteger(value.startedAt) ||
    !isPositiveInteger(value.deadline) ||
    value.deadline <= value.startedAt
  ) {
    return undefined;
  }
  return {
    roundNumber: value.roundNumber,
    startArticle: value.startArticle,
    goalArticle: value.goalArticle,
    startedAt: value.startedAt,
    deadline: value.deadline,
  };
}

function parsePlayer(value: unknown): CorePlayer | null {
  const cosmetics =
    isRecord(value) &&
    isRecord(value.cosmetics) &&
    hasExactKeys(value.cosmetics, ['faceId', 'hatId']) &&
    typeof value.cosmetics.faceId === 'string' &&
    typeof value.cosmetics.hatId === 'string'
      ? { faceId: value.cosmetics.faceId, hatId: value.cosmetics.hatId }
      : null;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'id',
      'name',
      'cosmetics',
      'isHost',
      'score',
      'roundPoints',
      'path',
      'finishedRank',
      'finishedAfterMs',
      'gaveUp',
      'away',
    ]) ||
    typeof value.id !== 'string' ||
    !isUuid(value.id) ||
    typeof value.name !== 'string' ||
    value.name.trim().length === 0 ||
    value.name !== value.name.trim() ||
    value.name.length > MAX_NAME_LENGTH ||
    !cosmetics ||
    !isValidCosmetics(cosmetics) ||
    typeof value.isHost !== 'boolean' ||
    !isNonNegativeInteger(value.score) ||
    !isNonNegativeInteger(value.roundPoints) ||
    !isStringArray(value.path) ||
    !isNullablePositiveInteger(value.finishedRank) ||
    !isNullableNonNegativeInteger(value.finishedAfterMs) ||
    typeof value.gaveUp !== 'boolean' ||
    typeof value.away !== 'boolean' ||
    (value.finishedRank === null) !== (value.finishedAfterMs === null) ||
    (value.gaveUp && value.finishedRank !== null)
  ) {
    return null;
  }
  return {
    id: value.id,
    name: value.name,
    cosmetics,
    isHost: value.isHost,
    score: value.score,
    roundPoints: value.roundPoints,
    path: value.path,
    finishedRank: value.finishedRank,
    finishedAfterMs: value.finishedAfterMs,
    gaveUp: value.gaveUp,
    away: value.away,
  };
}

function parseRoom(value: unknown): CoreRoom | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'code',
      'phase',
      'players',
      'round',
      'countdownEndsAt',
      'settings',
      'roundsPlayed',
      'ranksAssigned',
    ]) ||
    typeof value.code !== 'string' ||
    typeof value.phase !== 'string' ||
    !(ROOM_PHASES as readonly string[]).includes(value.phase) ||
    !Array.isArray(value.players) ||
    !isNullablePositiveInteger(value.countdownEndsAt) ||
    !isNonNegativeInteger(value.roundsPlayed) ||
    !isNonNegativeInteger(value.ranksAssigned)
  ) {
    return null;
  }
  const players = value.players.map(parsePlayer);
  const round = parseRound(value.round);
  const settings = parseSettings(value.settings);
  if (
    normalizeRoomCode(value.code) !== value.code ||
    players.some((player) => player === null) ||
    round === undefined ||
    settings === null
  ) {
    return null;
  }
  const room: CoreRoom = {
    code: value.code,
    phase: value.phase as CoreRoom['phase'],
    players: players as CorePlayer[],
    round,
    countdownEndsAt: value.countdownEndsAt,
    settings,
    roundsPlayed: value.roundsPlayed,
    ranksAssigned: value.ranksAssigned,
  };
  return isCoherentRoom(room) ? room : null;
}

function parseMemberships(value: unknown): Record<string, Membership> | null {
  if (!isRecord(value)) return null;
  const memberships: Record<string, Membership> = {};
  for (const [playerId, membership] of Object.entries(value)) {
    if (
      !isUuid(playerId) ||
      !isRecord(membership) ||
      !hasExactKeys(membership, ['credentialDigest', 'activeConnectionId']) ||
      typeof membership.credentialDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(membership.credentialDigest) ||
      (membership.activeConnectionId !== null &&
        (typeof membership.activeConnectionId !== 'string' ||
          !isUuid(membership.activeConnectionId)))
    ) {
      return null;
    }
    memberships[playerId] = {
      credentialDigest: membership.credentialDigest,
      activeConnectionId: membership.activeConnectionId,
    };
  }
  return memberships;
}

function parseJoinAttempts(value: unknown): Record<string, JoinAttempt> | null {
  if (!isRecord(value)) return null;
  const attempts: Record<string, JoinAttempt> = {};
  for (const [attemptId, attempt] of Object.entries(value)) {
    if (!isUuid(attemptId) || !isRecord(attempt)) return null;
    if (
      hasExactKeys(attempt, ['state', 'playerId']) &&
      attempt.state === 'promoted' &&
      typeof attempt.playerId === 'string' &&
      isUuid(attempt.playerId)
    ) {
      attempts[attemptId] = { state: 'promoted', playerId: attempt.playerId };
      continue;
    }
    if (
      hasExactKeys(attempt, [
        'state',
        'playerId',
        'playerName',
        'credentialDigest',
        'generation',
      ]) &&
      attempt.state === 'pending' &&
      typeof attempt.playerId === 'string' &&
      isUuid(attempt.playerId) &&
      typeof attempt.playerName === 'string' &&
      attempt.playerName.trim().length > 0 &&
      attempt.playerName === attempt.playerName.trim() &&
      attempt.playerName.length <= MAX_NAME_LENGTH &&
      typeof attempt.credentialDigest === 'string' &&
      /^[a-f0-9]{64}$/.test(attempt.credentialDigest) &&
      isNonNegativeInteger(attempt.generation)
    ) {
      attempts[attemptId] = {
        state: 'pending',
        playerId: attempt.playerId,
        playerName: attempt.playerName,
        credentialDigest: attempt.credentialDigest,
        generation: attempt.generation,
      };
      continue;
    }
    return null;
  }
  return attempts;
}

function parsePreparedPair(value: unknown): PreparedArticlePair | null | undefined {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['startArticle', 'goalArticle']) ||
    typeof value.startArticle !== 'string' ||
    value.startArticle.trim().length === 0 ||
    value.startArticle !== value.startArticle.trim() ||
    typeof value.goalArticle !== 'string' ||
    value.goalArticle.trim().length === 0 ||
    value.goalArticle !== value.goalArticle.trim() ||
    value.startArticle === value.goalArticle
  ) {
    return undefined;
  }
  return { startArticle: value.startArticle, goalArticle: value.goalArticle };
}

function parseRoundPreparation(value: unknown): RoundPreparation | null | undefined {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['token', 'difficulty', 'category', 'pair']) ||
    typeof value.token !== 'string' ||
    !isUuid(value.token) ||
    typeof value.difficulty !== 'string' ||
    !(DIFFICULTIES as readonly string[]).includes(value.difficulty) ||
    typeof value.category !== 'string' ||
    !(CATEGORIES as readonly string[]).includes(value.category)
  ) {
    return undefined;
  }
  const pair = parsePreparedPair(value.pair);
  if (pair === undefined) return undefined;
  return {
    token: value.token,
    difficulty: value.difficulty as Difficulty,
    category: value.category as Category,
    pair,
  };
}

function parseDeadline(value: unknown): RoomDeadline | null {
  if (!isRecord(value) || !isPositiveInteger(value.at)) {
    return null;
  }
  if (value.kind === 'membership-grace') {
    return hasExactKeys(value, ['kind', 'playerId', 'connectionId', 'at']) &&
      typeof value.playerId === 'string' &&
      isUuid(value.playerId) &&
      (value.connectionId === null ||
        (typeof value.connectionId === 'string' && isUuid(value.connectionId)))
      ? {
          kind: 'membership-grace',
          playerId: value.playerId,
          connectionId: value.connectionId,
          at: value.at,
        }
      : null;
  }
  if (
    !hasExactKeys(value, ['kind', 'token', 'at']) ||
    (value.kind !== 'round-preparation' &&
      value.kind !== 'countdown' &&
      value.kind !== 'round-timeout') ||
    typeof value.token !== 'string'
  ) {
    return null;
  }
  if (value.kind === 'round-timeout') {
    if (!/^round:[1-9]\d*:(?:0|[1-9]\d*)$/.test(value.token)) return null;
  } else if (!isUuid(value.token)) {
    return null;
  }
  return { kind: value.kind, token: value.token, at: value.at };
}

function parseDeadlines(value: unknown): RoomDeadline[] | null {
  if (!Array.isArray(value)) return null;
  const deadlines = value.map(parseDeadline);
  if (deadlines.some((deadline) => deadline === null)) return null;
  const parsed = deadlines as RoomDeadline[];
  if (parsed.filter((deadline) => deadline.kind !== 'membership-grace').length > 1) return null;
  const grace = parsed.filter(
    (deadline): deadline is MembershipGraceDeadline => deadline.kind === 'membership-grace',
  );
  if (new Set(grace.map((deadline) => deadline.playerId)).size !== grace.length) return null;
  const connectionIds = grace
    .map((deadline) => deadline.connectionId)
    .filter((connectionId): connectionId is string => connectionId !== null);
  if (new Set(connectionIds).size !== connectionIds.length) return null;
  return parsed;
}

function isCoherentRoom(room: CoreRoom): boolean {
  const playerIds = room.players.map((player) => player.id);
  if (
    new Set(playerIds).size !== playerIds.length ||
    room.ranksAssigned > room.players.length ||
    room.players.filter((player) => player.isHost).length !== 1
  ) {
    return false;
  }

  const ranks = room.players
    .map((player) => player.finishedRank)
    .filter((rank): rank is number => rank !== null)
    .sort((left, right) => left - right);
  if (ranks.length !== room.ranksAssigned || ranks.some((rank, index) => rank !== index + 1)) {
    return false;
  }

  switch (room.phase) {
    case 'lobby':
      return room.round === null && room.countdownEndsAt === null;
    case 'preparing':
      return room.round === null && room.countdownEndsAt === null;
    case 'countdown':
      return room.round === null && room.countdownEndsAt !== null;
    case 'racing':
      return (
        room.round !== null &&
        room.countdownEndsAt === null &&
        room.round.roundNumber === room.roundsPlayed + 1 &&
        isCoherentActiveRound(room)
      );
    case 'results':
      return (
        room.round !== null &&
        room.countdownEndsAt === null &&
        room.round.roundNumber === room.roundsPlayed &&
        isCoherentActiveRound(room)
      );
  }
}

function isCoherentActiveRound(room: CoreRoom): boolean {
  const round = room.round;
  if (!round || round.deadline - round.startedAt !== room.settings.roundDurationMs) return false;
  return room.players.every(
    (player) =>
      player.path[0] === round.startArticle &&
      (player.finishedAfterMs === null ||
        player.finishedAfterMs <= room.settings.roundDurationMs) &&
      (room.phase !== 'racing' || player.roundPoints === 0),
  );
}

/** Parse all durable bytes before they enter the core or a client view. */
export function parseRoomSnapshot(value: unknown): RoomSnapshot {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'room',
      'memberships',
      'joinAttempts',
      'roundPreparation',
      'deadlines',
    ]) ||
    value.schemaVersion !== ROOM_SNAPSHOT_VERSION
  ) {
    throw new Error('Invalid Room snapshot version.');
  }
  const room = parseRoom(value.room);
  const memberships = parseMemberships(value.memberships);
  const joinAttempts = parseJoinAttempts(value.joinAttempts);
  const roundPreparation = parseRoundPreparation(value.roundPreparation);
  const deadlines = parseDeadlines(value.deadlines);
  if (!room) throw new Error('Invalid Room snapshot state.');
  if (!memberships) throw new Error('Invalid Room snapshot Memberships.');
  if (!joinAttempts) throw new Error('Invalid Room snapshot join attempts.');
  if (roundPreparation === undefined) throw new Error('Invalid Room snapshot Round preparation.');
  if (!deadlines) throw new Error('Invalid Room snapshot Deadlines.');
  if (
    room.players.length === 0 ||
    room.players.some((player) => memberships[player.id] === undefined) ||
    Object.keys(memberships).length !== room.players.length
  ) {
    throw new Error('Invalid Room snapshot membership invariants.');
  }
  for (const attempt of Object.values(joinAttempts)) {
    const player = room.players.find((candidate) => candidate.id === attempt.playerId);
    if (attempt.state === 'pending') {
      if (player || memberships[attempt.playerId] !== undefined) {
        throw new Error('Invalid pending join attempt.');
      }
    } else if (!player || memberships[attempt.playerId] === undefined) {
      throw new Error('Invalid promoted join attempt.');
    }
  }
  const attemptedPlayerIds = Object.values(joinAttempts).map((attempt) => attempt.playerId);
  if (new Set(attemptedPlayerIds).size !== attemptedPlayerIds.length) {
    throw new Error('Invalid join attempt Player identity aliases.');
  }
  if (!isCoherentMembershipState(room, memberships, deadlines)) {
    throw new Error('Invalid Room snapshot Connection ownership.');
  }
  if (!isCoherentRuntimeState(room, roundPreparation, deadlines)) {
    throw new Error('Invalid Room snapshot pending runtime state.');
  }
  return {
    schemaVersion: ROOM_SNAPSHOT_VERSION,
    room,
    memberships,
    joinAttempts,
    roundPreparation,
    deadlines,
  };
}

function isCoherentRuntimeState(
  room: CoreRoom,
  preparation: RoundPreparation | null,
  deadlines: readonly RoomDeadline[],
): boolean {
  const deadline = phaseDeadline(deadlines);
  const matchesSettings =
    preparation?.difficulty === room.settings.difficulty &&
    preparation.category === room.settings.category;
  if (room.phase === 'preparing') {
    return (
      preparation !== null &&
      matchesSettings &&
      preparation.pair === null &&
      deadline?.kind === 'round-preparation' &&
      deadline.token === preparation.token
    );
  }
  if (room.phase === 'countdown') {
    return (
      preparation !== null &&
      matchesSettings &&
      preparation.pair !== null &&
      deadline?.kind === 'countdown' &&
      deadline.token === preparation.token &&
      deadline.at === room.countdownEndsAt
    );
  }
  if (room.phase === 'racing') {
    return (
      preparation === null &&
      room.round !== null &&
      deadline?.kind === 'round-timeout' &&
      deadline.token === roundTimeoutToken(room.round) &&
      deadline.at === room.round.deadline
    );
  }
  return preparation === null && deadline === null;
}

function isCoherentMembershipState(
  room: CoreRoom,
  memberships: Record<string, Membership>,
  deadlines: readonly RoomDeadline[],
): boolean {
  const grace = deadlines.filter(
    (deadline): deadline is MembershipGraceDeadline => deadline.kind === 'membership-grace',
  );
  const activeConnectionIds = Object.values(memberships)
    .map((membership) => membership.activeConnectionId)
    .filter((connectionId): connectionId is string => connectionId !== null);
  const graceConnectionIds = grace
    .map((deadline) => deadline.connectionId)
    .filter((connectionId): connectionId is string => connectionId !== null);
  const ownedConnectionIds = [...activeConnectionIds, ...graceConnectionIds];
  if (new Set(ownedConnectionIds).size !== ownedConnectionIds.length) return false;
  const initialGrace = grace.filter((deadline) => deadline.connectionId === null);
  if (initialGrace.length > 1) return false;
  if (initialGrace.length === 1) {
    const player = room.players[0];
    if (
      room.players.length !== 1 ||
      Object.keys(memberships).length !== 1 ||
      grace.length !== 1 ||
      !player ||
      player.id !== initialGrace[0]!.playerId ||
      !player.isHost ||
      !player.away ||
      room.phase !== 'lobby' ||
      room.roundsPlayed !== 0 ||
      room.ranksAssigned !== 0 ||
      room.countdownEndsAt !== null ||
      room.round !== null
    ) {
      return false;
    }
  }
  if (
    grace.some(
      (deadline) =>
        memberships[deadline.playerId]?.activeConnectionId !== null ||
        !room.players.some((player) => player.id === deadline.playerId && player.away),
    )
  ) {
    return false;
  }

  return room.players.every((player) => {
    const membership = memberships[player.id];
    const playerGrace = grace.filter((deadline) => deadline.playerId === player.id);
    if (!membership) return false;
    if (membership.activeConnectionId === null) {
      return player.away && playerGrace.length === 1;
    }
    return !player.away && playerGrace.length === 0;
  });
}

export function roundTimeoutToken(round: Pick<RoundView, 'roundNumber' | 'startedAt'>): string {
  return `round:${round.roundNumber}:${round.startedAt}`;
}
