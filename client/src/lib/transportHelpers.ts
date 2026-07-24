import type { ServerMessage } from '@wikispeedrun/shared';
import { parseServerMessage } from './serverMessage.js';
import { TransportConnectionError } from './transportTypes.js';

export function parseSocketMessage(raw: unknown): ServerMessage | null {
  if (typeof raw !== 'string') return null;
  try {
    return parseServerMessage(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function closeFailure(event: CloseEvent): TransportConnectionError {
  if (event.code === 4001) {
    return new TransportConnectionError(
      'connection-replaced',
      'This Room Membership was opened in another tab.',
    );
  }
  if (event.code === 4003) {
    return new TransportConnectionError('invalid-membership', 'The Room Membership is invalid.');
  }
  // In the Worker protocol these standard policy close codes have one
  // intentionally narrow meaning. Preserve that mapping when the preceding
  // structured room/error frame is dropped in transit.
  if (event.code === 1008) {
    return new TransportConnectionError(
      'rate-limited',
      'This Room Membership sent too many messages. Try again shortly.',
    );
  }
  if (event.code === 1009) {
    return new TransportConnectionError(
      'message-too-large',
      'Room messages may be at most 4,096 UTF-8 bytes.',
    );
  }
  return new TransportConnectionError('room-unavailable', 'The Room connection was interrupted.');
}
