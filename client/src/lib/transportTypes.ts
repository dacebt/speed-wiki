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
