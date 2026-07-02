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
  notice: { code: ErrorCode | 'disconnected'; message: string } | null;
}

export type AppEvent =
  | { type: 'socket/connected' }
  | { type: 'socket/disconnected' }
  | { type: 'server/message'; message: ServerMessage }
  | { type: 'ui/dismissNotice' };

const initialState: AppState = { connected: false, you: null, room: null, notice: null };

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
        notice: { code: 'disconnected', message: 'The connection to the salon was lost.' },
      };
    case 'server/message': {
      const { message } = event;
      if (message.type === 'room/sync') {
        return { ...state, room: message.room, you: message.you };
      }
      return { ...state, notice: { code: message.code, message: message.message } };
    }
    case 'ui/dismissNotice':
      return { ...state, notice: null };
  }
}

const StateContext = createContext<AppState>(initialState);
const DispatchContext = createContext<Dispatch<AppEvent>>(() => undefined);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reduce, initialState);

  useEffect(
    () =>
      subscribe({
        onMessage: (message) => dispatch({ type: 'server/message', message }),
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
