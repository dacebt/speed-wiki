import type { ErrorCode, RoomSync, ServerMessage } from '@wikispeedrun/shared';
import {
  createContext,
  useContext,
  useEffect,
  useReducer,
  type Dispatch,
  type ReactNode,
} from 'react';
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
  notice: null,
};

export function reduce(state: AppState, event: AppEvent): AppState {
  switch (event.type) {
    case 'socket/connected':
      return { ...state, connected: true };
    case 'socket/disconnected':
      // The server keeps no session for us; a drop means starting over.
      return {
        connected: false,
        you: null,
        room: null,
        clockOffset: 0,
        notice: { code: 'disconnected', message: 'Connection to the server was lost.' },
      };
    case 'server/message': {
      const { message } = event;
      if (message.type === 'room/sync') {
        return {
          ...state,
          room: message.room,
          you: message.you,
          clockOffset: message.at - event.receivedAt,
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
