import { INTENT_EVENT, MESSAGE_EVENT, type ClientIntent } from '@wikispeedrun/shared';
import { io, type Socket } from 'socket.io-client';
import { getLastRoom, getPlayerId, getPlayerName } from './identity.js';
import { parseServerMessage } from './serverMessage.js';
import type { InviteClaim, TransportHandlers } from './transportTypes.js';

// The one place socket code lives on the client. Everything else sends
// intents and receives parsed server messages.

const socket: Socket = io();

export const supportsInvitedJoining = true;
export const supportsLobbyActions = true;

export function claimStoredInvite(_roomCode: string): InviteClaim {
  return 'join';
}

// Distinguishes the first connect from a reconnect so auto-rejoin can defer to
// an invite param on a fresh load but always fire on a dropped-then-restored link.
let hasConnected = false;

export function sendIntent(intent: ClientIntent): void {
  socket.emit(INTENT_EVENT, intent);
}

export async function createRoom(playerName: string): Promise<void> {
  sendIntent({ type: 'room/create', playerName, playerId: getPlayerId() });
}

export async function joinRoom(playerName: string, code: string): Promise<void> {
  sendIntent({ type: 'room/join', code, playerName, playerId: getPlayerId() });
}

/** Re-enter the last room after a (re)connect using the persisted identity, so a
    refresh or a wifi blip lands you back in your seat instead of on Home. On the
    very first connect an invite `?code=` in the URL takes precedence and is left
    to HomeScreen. Rejoining a dead room degrades to the room-not-found toast. */
function autoRejoin(isReconnect: boolean): void {
  const code = getLastRoom();
  const name = getPlayerName().trim();
  if (!code || name.length === 0) return;
  if (!isReconnect && new URLSearchParams(window.location.search).has('code')) return;
  sendIntent({ type: 'room/join', code, playerName: name, playerId: getPlayerId() });
}

/** Subscribe to the socket; returns an unsubscribe function. */
export function subscribe(handlers: TransportHandlers): () => void {
  const handleMessage = (raw: unknown) => {
    const message = parseServerMessage(raw);
    if (message) handlers.onMessage(message);
  };
  const handleConnect = () => {
    autoRejoin(hasConnected);
    hasConnected = true;
    handlers.onConnect();
  };
  const handleDisconnect = () => {
    handlers.onDisconnect({ type: 'reconnecting' });
  };
  socket.on(MESSAGE_EVENT, handleMessage);
  socket.on('connect', handleConnect);
  socket.on('disconnect', handleDisconnect);
  if (socket.connected) handleConnect();
  return () => {
    socket.off(MESSAGE_EVENT, handleMessage);
    socket.off('connect', handleConnect);
    socket.off('disconnect', handleDisconnect);
  };
}
