import type { ErrorCode, ServerMessage } from '@wikispeedrun/shared';

export type TransportDisconnect =
  | { type: 'reconnecting' }
  | {
      type: 'terminal';
      code: ErrorCode | 'disconnected';
      message: string;
    };

export interface TransportHandlers {
  onMessage: (message: ServerMessage) => void;
  onConnect: () => void;
  onDisconnect: (disconnect: TransportDisconnect) => void;
}

export interface RoomMembership {
  roomCode: string;
  playerId: string;
  rejoinCredential: string;
}

export type InviteClaim = 'join' | 'resume' | 'resume-with-query';

export class TransportConnectionError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
