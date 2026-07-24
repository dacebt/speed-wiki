import {
  normalizeRoomCode,
  type ClientIntent,
  type ErrorCode,
  type RoomConnectMessage,
  type ServerMessage,
} from '@wikispeedrun/shared';
import { getLastRoom, setLastRoom } from './identity.js';
import {
  createRoomMembership,
  joinRoomMembership,
  parseRoomMembershipResponse,
  RoomRequestError,
} from './roomApi.js';
import {
  deleteRoomMembership,
  loadRoomMembership,
  persistRoomMembership,
  type StoredMembershipResult,
} from './roomMembership.js';
import { closeFailure, delay, parseSocketMessage } from './transportHelpers.js';
import {
  TransportConnectionError,
  type InviteClaim,
  type RoomMembership,
  type TransportDisconnect,
  type TransportHandlers,
} from './transportTypes.js';

export const supportsInvitedJoining = true;
export const supportsLobbyActions = false;
export const supportsRoundStart = true;
export const supportsRaceActions = true;
export const supportsKick = true;
export { parseRoomMembershipResponse as parseCreateRoomResponse };

let claimedInviteMembership: RoomMembership | null = null;

export function claimStoredInvite(codeInput: string): InviteClaim {
  const code = normalizeRoomCode(codeInput);
  if (code === null) return 'join';
  const loaded = loadRoomMembership(code);
  if (!loaded.ok) return 'join';
  claimedInviteMembership = loaded.membership;
  try {
    setLastRoom(code);
    return 'resume';
  } catch {
    return 'resume-with-query';
  }
}

const FIRST_SYNC_DEADLINE_MS = 10_000;
const RECONNECT_ATTEMPTS = 3;
const handlers = new Set<TransportHandlers>();
const intentionalClosures = new WeakSet<WebSocket>();

let connection: WebSocket | null = null;
let activeMembership: RoomMembership | null = null;
let membershipOperation: Promise<void> | null = null;
let reconnectOperation: ReconnectOperation | null = null;
let currentAttempt: ConnectionAttempt | null = null;
let sessionVersion = 0;
let initialResumeScheduled = false;
let initialResumeAttempted = false;

interface ReconnectOperation {
  membership: RoomMembership;
  sessionVersion: number;
  cancelled: boolean;
  promise: Promise<void> | null;
}

interface ConnectionAttempt {
  membership: RoomMembership;
  sessionVersion: number;
  socket: WebSocket;
  cancelled: boolean;
  cancel: (reason: string) => void;
}

class ConnectionAttemptCancelled extends Error {}

export function createRoom(playerName: string): Promise<void> {
  return runMembershipOperation(() => createRoomMembership(playerName));
}

export function joinRoom(playerName: string, codeInput: string): Promise<void> {
  const code = normalizeRoomCode(codeInput);
  if (!code) return failOperation('room-not-found', 'No room found with that code.');
  return runMembershipOperation(() => joinRoomMembership(playerName, code));
}

function runMembershipOperation(request: () => Promise<RoomMembership>): Promise<void> {
  if (membershipOperation) return membershipOperation;
  const attempt = request()
    .then((membership) => replaceMembership(membership))
    .catch((error: unknown) => {
      const failure =
        error instanceof RoomRequestError || error instanceof TransportConnectionError
          ? error
          : new TransportConnectionError('internal-error', 'The Room connection failed.');
      terminate(failure.code, failure.message);
      throw failure;
    });
  const shared = attempt.finally(() => {
    if (membershipOperation === shared) membershipOperation = null;
  });
  membershipOperation = shared;
  return shared;
}

async function replaceMembership(membership: RoomMembership): Promise<void> {
  try {
    persistRoomMembership(membership);
    setLastRoom(membership.roomCode);
  } catch {
    throw new TransportConnectionError('internal-error', 'The Room membership could not be saved.');
  }
  const version = ++sessionVersion;
  cancelReconnect('Replaced by a new Room Membership.');
  closeCurrent('Replaced by a new Room Membership.');
  activeMembership = membership;
  await openMembership(membership, version, null);
}

export function sendIntent(intent: ClientIntent): void {
  if (connection?.readyState === WebSocket.OPEN) {
    connection.send(JSON.stringify(intent));
    return;
  }
  notifyMessage({
    type: 'room/error',
    code: 'room-unavailable',
    message: 'The Room connection is not ready.',
  });
}

export function subscribe(nextHandlers: TransportHandlers): () => void {
  handlers.add(nextHandlers);
  scheduleInitialResume();
  return () => {
    handlers.delete(nextHandlers);
    queueMicrotask(() => {
      if (handlers.size !== 0) return;
      sessionVersion += 1;
      cancelReconnect('Room transport has no subscribers.');
      closeCurrent('Room transport has no subscribers.');
      activeMembership = null;
    });
  };
}

function scheduleInitialResume(): void {
  if (initialResumeScheduled || initialResumeAttempted) return;
  initialResumeScheduled = true;
  queueMicrotask(() => {
    initialResumeScheduled = false;
    if (initialResumeAttempted || handlers.size === 0 || membershipOperation) return;
    initialResumeAttempted = true;
    const claimedMembership = claimedInviteMembership;
    claimedInviteMembership = null;
    if (claimedMembership) {
      const version = ++sessionVersion;
      activeMembership = claimedMembership;
      beginReconnect(claimedMembership, false, version);
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const inviteCode = normalizeRoomCode(params.get('code') ?? '');
    const roomCode = inviteCode ?? getLastRoom();
    if (!roomCode) return;
    const loaded = loadRoomMembership(roomCode);
    if (inviteCode && !loaded.ok) return;
    if (!loaded.ok) {
      terminateStoredMembershipFailure(loaded);
      return;
    }
    const version = ++sessionVersion;
    activeMembership = loaded.membership;
    beginReconnect(loaded.membership, false, version);
  });
}

function openMembership(
  membership: RoomMembership,
  version: number,
  reconnect: ReconnectOperation | null,
): Promise<void> {
  const url = new URL(`/api/rooms/${membership.roomCode}/websocket`, window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(url);
  connection = socket;

  return new Promise((resolve, reject) => {
    let synced = false;
    let finished = false;
    const attempt: ConnectionAttempt = {
      membership,
      sessionVersion: version,
      socket,
      cancelled: false,
      cancel(reason: string): void {
        if (attempt.cancelled) return;
        attempt.cancelled = true;
        if (currentAttempt === attempt) currentAttempt = null;
        if (connection === socket) connection = null;
        closeIntentionally(socket, reason);
        if (!finished) {
          finished = true;
          clearTimeout(deadline);
          reject(new ConnectionAttemptCancelled(reason));
        }
      },
    };
    currentAttempt = attempt;
    const deadline = setTimeout(
      () => failAttempt('room-unavailable', 'The Room lobby did not become ready in time.'),
      FIRST_SYNC_DEADLINE_MS,
    );

    function ownsAttempt(): boolean {
      return (
        !attempt.cancelled &&
        currentAttempt === attempt &&
        connection === socket &&
        sessionVersion === version &&
        activeMembership === membership &&
        (synced || reconnect === null || (reconnectOperation === reconnect && !reconnect.cancelled))
      );
    }

    function finishFailure(code: ErrorCode, message: string): void {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      attempt.cancelled = true;
      if (currentAttempt === attempt) currentAttempt = null;
      if (connection === socket) connection = null;
      closeIntentionally(socket, 'Room connection attempt ended.');
      reject(new TransportConnectionError(code, message));
    }

    function failAttempt(code: ErrorCode, message: string): void {
      if (synced) {
        terminateOwned(version, membership, code, message);
        return;
      }
      if (code === 'kicked' || code === 'invalid-membership') {
        deleteTerminalMembership(membership.roomCode);
      }
      finishFailure(code, message);
    }

    socket.addEventListener('open', () => {
      if (!ownsAttempt()) return;
      notifyConnect();
      socket.send(
        JSON.stringify({
          type: 'room/connect',
          playerId: membership.playerId,
          rejoinCredential: membership.rejoinCredential,
        } satisfies RoomConnectMessage),
      );
    });
    socket.addEventListener('message', (event) => {
      if (!ownsAttempt()) return;
      const message = parseSocketMessage(event.data);
      if (!message) {
        failAttempt('internal-error', 'The Room service sent an invalid lobby response.');
        return;
      }
      if (message.type === 'room/error') {
        if (message.code === 'connection-replaced') {
          if (synced) {
            terminateOwned(version, membership, message.code, message.message);
          } else {
            finishFailure(message.code, message.message);
          }
          return;
        }
        failAttempt(message.code, message.message);
        return;
      }
      if (message.you !== membership.playerId || message.room.code !== membership.roomCode) {
        failAttempt('invalid-membership', 'The Room service returned the wrong Membership.');
        return;
      }
      if (!ownsAttempt()) return;
      synced = true;
      activeMembership = membership;
      if (reconnect !== null && reconnectOperation === reconnect) {
        reconnectOperation = null;
      }
      notifyMessage(message);
      if (!finished) {
        finished = true;
        clearTimeout(deadline);
        resolve();
      }
    });
    socket.addEventListener('close', (event) => {
      if (intentionalClosures.has(socket) || !ownsAttempt()) return;
      currentAttempt = null;
      if (connection === socket) connection = null;
      const failure = closeFailure(event);
      if (!synced) {
        if (failure.code === 'invalid-membership') {
          deleteTerminalMembership(membership.roomCode);
        }
        finishFailure(failure.code, failure.message);
        return;
      }
      if (failure.code === 'connection-replaced' || failure.code === 'invalid-membership') {
        terminateOwned(version, membership, failure.code, failure.message);
        return;
      }
      beginReconnect(membership, true, version);
    });
    socket.addEventListener('error', () => {
      if (!ownsAttempt()) return;
      if (!synced) finishFailure('room-unavailable', 'The Room connection failed.');
    });
  });
}

function beginReconnect(membership: RoomMembership, announce: boolean, version: number): void {
  if (reconnectOperation || activeMembership !== membership || sessionVersion !== version) {
    return;
  }
  if (announce) notifyDisconnect({ type: 'reconnecting' });
  const operation: ReconnectOperation = {
    membership,
    sessionVersion: version,
    cancelled: false,
    promise: null,
  };
  reconnectOperation = operation;
  operation.promise = reconnect(operation).finally(() => {
    if (reconnectOperation === operation) reconnectOperation = null;
  });
}

async function reconnect(operation: ReconnectOperation): Promise<void> {
  const { membership, sessionVersion: version } = operation;
  for (let attempt = 0; attempt < RECONNECT_ATTEMPTS; attempt += 1) {
    if (!ownsReconnect(operation)) return;
    if (attempt > 0) {
      await delay(attempt * 250);
      if (!ownsReconnect(operation)) return;
    }
    try {
      await openMembership(membership, version, operation);
      if (!ownsReconnect(operation)) return;
      return;
    } catch (error) {
      if (error instanceof ConnectionAttemptCancelled || !ownsReconnect(operation)) return;
      if (
        error instanceof TransportConnectionError &&
        (error.code === 'invalid-membership' || error.code === 'connection-replaced')
      ) {
        terminateOwned(version, membership, error.code, error.message);
        return;
      }
    }
  }
  if (ownsReconnect(operation)) {
    terminateOwned(
      version,
      membership,
      'room-unavailable',
      'The Room connection could not be restored.',
    );
  }
}

function ownsReconnect(operation: ReconnectOperation): boolean {
  return (
    reconnectOperation === operation &&
    !operation.cancelled &&
    sessionVersion === operation.sessionVersion &&
    activeMembership === operation.membership
  );
}

function terminateStoredMembershipFailure(result: Exclude<StoredMembershipResult, { ok: true }>) {
  const message =
    result.reason === 'storage-failed'
      ? 'The saved Room Membership could not be read.'
      : 'The saved Room Membership is missing or invalid.';
  terminate('invalid-membership', message);
}

function terminate(code: ErrorCode, message: string): void {
  sessionVersion += 1;
  cancelReconnect('Room connection ended.');
  activeMembership = null;
  closeCurrent('Room connection ended.');
  notifyDisconnect({ type: 'terminal', code, message });
}

function terminateOwned(
  version: number,
  membership: RoomMembership,
  code: ErrorCode,
  message: string,
): void {
  if (sessionVersion !== version || activeMembership !== membership) return;
  if (code === 'kicked' || code === 'invalid-membership') {
    deleteTerminalMembership(membership.roomCode);
  }
  terminate(code, message);
}

function deleteTerminalMembership(roomCode: string): void {
  try {
    deleteRoomMembership(roomCode);
  } catch {
    // Terminal UI and connection teardown still have to complete when storage is unavailable.
  }
}

function cancelReconnect(reason: string): void {
  const operation = reconnectOperation;
  if (!operation) return;
  operation.cancelled = true;
  reconnectOperation = null;
  if (
    currentAttempt?.sessionVersion === operation.sessionVersion &&
    currentAttempt.membership === operation.membership
  ) {
    currentAttempt.cancel(reason);
  }
}

function closeCurrent(reason: string): void {
  if (currentAttempt) {
    currentAttempt.cancel(reason);
    return;
  }
  const socket = connection;
  connection = null;
  if (socket) closeIntentionally(socket, reason);
}

function closeIntentionally(socket: WebSocket, reason: string): void {
  intentionalClosures.add(socket);
  socket.close(1000, reason);
}

function failOperation(code: ErrorCode, message: string): Promise<never> {
  terminate(code, message);
  return Promise.reject(new RoomRequestError(code, message));
}

function notifyMessage(message: ServerMessage): void {
  for (const listener of handlers) listener.onMessage(message);
}

function notifyConnect(): void {
  for (const listener of handlers) listener.onConnect();
}

function notifyDisconnect(disconnect: TransportDisconnect): void {
  for (const listener of handlers) listener.onDisconnect(disconnect);
}
