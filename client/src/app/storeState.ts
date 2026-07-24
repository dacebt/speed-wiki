import type { ErrorCode, RoomSync, ServerMessage } from '@wikispeedrun/shared';
import type { TransportDisconnect } from '../lib/transportTypes.js';

export interface AppState {
  connected: boolean;
  /** Our player id, assigned by the server on the first sync. */
  you: string | null;
  room: RoomSync | null;
  /** serverClock − clientClock at last sync; add to Date.now() to compare with server timestamps. */
  clockOffset: number;
  /** Socket dropped while in a room; the room is held and a rejoin is in flight. */
  reconnecting: boolean;
  notice: { code: ErrorCode | 'disconnected'; message: string } | null;
}

export type AppEvent =
  | { type: 'socket/connected' }
  | { type: 'socket/disconnected'; disconnect: TransportDisconnect }
  | { type: 'room/message'; message: ServerMessage; receivedAt: number }
  | { type: 'ui/dismissNotice' }
  | { type: 'ui/notice'; code: ErrorCode; message: string };

export const initialAppState: AppState = {
  connected: false,
  you: null,
  room: null,
  clockOffset: 0,
  reconnecting: false,
  notice: null,
};

export function shouldClearLastRoom(state: AppState): boolean {
  if (state.room !== null || state.notice === null) return false;
  return (
    state.notice.code === 'room-not-found' ||
    state.notice.code === 'invalid-membership' ||
    state.notice.code === 'kicked'
  );
}

export function reduceAppState(state: AppState, event: AppEvent): AppState {
  switch (event.type) {
    case 'socket/connected':
      return { ...state, connected: true };
    case 'socket/disconnected': {
      if (event.disconnect.type === 'terminal') {
        return {
          ...initialAppState,
          notice: {
            code: event.disconnect.code,
            message: event.disconnect.message,
          },
        };
      }
      // In a room, the server holds our slot through a grace window and the
      // socket layer auto-rejoins on reconnect — so keep the room on screen and
      // show a reconnecting state instead of bouncing to Home. With no room, a
      // drop just means the server is unreachable; reset.
      return state.room === null
        ? {
            ...initialAppState,
            notice: { code: 'disconnected', message: 'Connection to the server was lost.' },
          }
        : { ...state, connected: false, reconnecting: true };
    }
    case 'room/message': {
      const { message } = event;
      if (message.type === 'room/sync') {
        return {
          ...state,
          room: message.room,
          you: message.you,
          clockOffset: message.at - event.receivedAt,
          reconnecting: false,
          // Entering a room from Home supersedes any lingering transient toast
          // (e.g. the removal notice when a kicked player rejoins). Notices
          // raised while already in a room — like the out-of-bounds warning —
          // are left alone, since a full-state sync arrives on every change.
          notice: state.room === null ? null : state.notice,
        };
      }
      // Being kicked ends our membership: clear room state and land on Home,
      // the same reset a disconnect performs, with the removal notice.
      if (message.code === 'kicked') {
        return {
          ...initialAppState,
          connected: state.connected,
          notice: { code: message.code, message: message.message },
        };
      }
      // A rejoin (or manual join) to a room the server no longer has: our held
      // slot is gone, so drop back to Home rather than dangling in a dead room.
      if (message.code === 'room-not-found' && state.room !== null) {
        return {
          ...initialAppState,
          connected: state.connected,
          notice: { code: message.code, message: message.message },
        };
      }
      return { ...state, notice: { code: message.code, message: message.message } };
    }
    case 'ui/dismissNotice':
      return { ...state, notice: null };
    case 'ui/notice':
      return { ...state, notice: { code: event.code, message: event.message } };
  }
}
