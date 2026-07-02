import {
  INTENT_EVENT,
  MESSAGE_EVENT,
  type ClientIntent,
  type ServerMessage,
} from '@wikispeedrun/shared';
import { io, type Socket } from 'socket.io-client';

// The one place socket code lives on the client. Everything else sends
// intents and receives parsed server messages.

const socket: Socket = io();

export function sendIntent(intent: ClientIntent): void {
  socket.emit(INTENT_EVENT, intent);
}

export interface SocketHandlers {
  onMessage: (message: ServerMessage) => void;
  onConnect: () => void;
  onDisconnect: () => void;
}

/** Subscribe to the socket; returns an unsubscribe function. */
export function subscribe(handlers: SocketHandlers): () => void {
  const handleMessage = (raw: unknown) => {
    const message = parseServerMessage(raw);
    if (message) handlers.onMessage(message);
  };
  socket.on(MESSAGE_EVENT, handleMessage);
  socket.on('connect', handlers.onConnect);
  socket.on('disconnect', handlers.onDisconnect);
  if (socket.connected) handlers.onConnect();
  return () => {
    socket.off(MESSAGE_EVENT, handleMessage);
    socket.off('connect', handlers.onConnect);
    socket.off('disconnect', handlers.onDisconnect);
  };
}

function parseServerMessage(raw: unknown): ServerMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const msg = raw as Record<string, unknown>;
  if (
    msg.type === 'room/sync' &&
    typeof msg.you === 'string' &&
    typeof msg.room === 'object' &&
    msg.room !== null &&
    typeof msg.at === 'number'
  ) {
    return raw as ServerMessage;
  }
  if (msg.type === 'room/error' && typeof msg.code === 'string' && typeof msg.message === 'string') {
    return raw as ServerMessage;
  }
  return null;
}
