import {
  createContext,
  useContext,
  useEffect,
  useReducer,
  type Dispatch,
  type ReactNode,
} from 'react';
import { clearLastRoom, setLastRoom } from '../lib/identity';
import { subscribe } from '../lib/transport';
import {
  initialAppState,
  reduceAppState,
  shouldClearLastRoom,
  type AppEvent,
  type AppState,
} from './storeState.js';

// MVU: client state is a reducer over server messages and local UI events.
// Screens derive from `room.phase`; nothing here computes game outcomes.

const StateContext = createContext<AppState>(initialAppState);
const DispatchContext = createContext<Dispatch<AppEvent>>(() => undefined);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reduceAppState, initialAppState);

  useEffect(
    () =>
      subscribe({
        onMessage: (message) => dispatch({ type: 'room/message', message, receivedAt: Date.now() }),
        onConnect: () => dispatch({ type: 'socket/connected' }),
        onDisconnect: (disconnect) => dispatch({ type: 'socket/disconnected', disconnect }),
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
  const rejectedOnHome = shouldClearLastRoom(state);
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
