import type { ErrorCode, RoomSync, ServerMessage } from '@wikispeedrun/shared';
import {
  createContext,
  useContext,
  useEffect,
  useReducer,
  type Dispatch,
  type ReactNode,
} from 'react';
import { clearLastRoom, setLastRoom } from '../lib/identity';
import { subscribe } from '../lib/socket';

// MVU: client state is a reducer over server messages and local UI events.
// Screens derive from `room.phase`; nothing here computes game outcomes.

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
  | { type: 'socket/disconnected' }
  | { type: 'server/message'; message: ServerMessage; receivedAt: number }
  | { type: 'ui/dismissNotice' }
  | { type: 'ui/notice'; code: ErrorCode; message: string };

const initialState: AppState = {
  connected: false,
  you: null,
  room: null,
  clockOffset: 0,
  reconnecting: false,
  notice: null,
};

function reduce(state: AppState, event: AppEvent): AppState {
  switch (event.type) {
    case 'socket/connected':
      return { ...state, connected: true };
    case 'socket/disconnected':
      // In a room, the server holds our slot through a grace window and the
      // socket layer auto-rejoins on reconnect — so keep the room on screen and
      // show a reconnecting state instead of bouncing to Home. With no room, a
      // drop just means the server is unreachable; reset.
      return state.room === null
        ? {
            ...initialState,
            notice: { code: 'disconnected', message: 'Connection to the server was lost.' },
          }
        : { ...state, connected: false, reconnecting: true };
    case 'server/message': {
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
          ...initialState,
          connected: state.connected,
          notice: { code: message.code, message: message.message },
        };
      }
      // A rejoin (or manual join) to a room the server no longer has: our held
      // slot is gone, so drop back to Home rather than dangling in a dead room.
      if (message.code === 'room-not-found' && state.room !== null) {
        return {
          ...initialState,
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

const StateContext = createContext<AppState>(initialState);
const DispatchContext = createContext<Dispatch<AppEvent>>(() => undefined);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reduce, initialState);

  useEffect(
    () =>
      subscribe({
        onMessage: (message) =>
          dispatch({ type: 'server/message', message, receivedAt: Date.now() }),
        onConnect: () => dispatch({ type: 'socket/connected' }),
        onDisconnect: () => dispatch({ type: 'socket/disconnected' }),
      }),
    [],
  );

  // Mirror room membership into localStorage so the socket layer can auto-rejoin
  // after a refresh or reconnect. Only *set* here — clearing on an empty room at
  // mount would wipe a persisted code before auto-rejoin could read it.
  const roomCode = state.room?.code ?? null;
  useEffect(() => {
    if (roomCode) setLastRoom(roomCode);
  }, [roomCode]);

  // Any server error shown while we're on Home means an auto-rejoin (or manual
  // join) was rejected — dead room, race underway, bad name, or a kick. Forget
  // the stored code uniformly so a reload doesn't keep re-attempting a room we
  // can't get into. ('disconnected' is a local notice, not a join rejection.)
  const rejectedOnHome =
    state.room === null && state.notice !== null && state.notice.code !== 'disconnected';
  useEffect(() => {
    if (rejectedOnHome) clearLastRoom();
  }, [rejectedOnHome]);

  return (
    <StateContext.Provider value={state}>
      <DispatchContext.Provider value={dispatch}>{children}</DispatchContext.Provider>
    </StateContext.Provider>
  );
}

export function useAppState(): AppState {
  return useContext(StateContext);
}

export function useAppDispatch(): Dispatch<AppEvent> {
  return useContext(DispatchContext);
}
