import { useEffect } from 'react';
import { useAppDispatch, useAppState } from './app/store';
import { CountdownScreen } from './features/countdown/CountdownScreen';
import { HomeScreen } from './features/home/HomeScreen';
import { LobbyScreen } from './features/lobby/LobbyScreen';
import { RaceScreen } from './features/race/RaceScreen';
import { ResultsScreen } from './features/results/ResultsScreen';

export default function App() {
  const { room, notice, reconnecting } = useAppState();
  const dispatch = useAppDispatch();

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => dispatch({ type: 'ui/dismissNotice' }), 4000);
    return () => clearTimeout(timer);
  }, [notice, dispatch]);

  return (
    <>
      {renderScreen()}
      {reconnecting && (
        <div className="reconnecting" role="status">
          Reconnecting…
        </div>
      )}
      {notice && <div className="toast">{notice.message}</div>}
    </>
  );

  function renderScreen() {
    if (!room) return <HomeScreen />;
    switch (room.phase) {
      case 'lobby':
        return <LobbyScreen />;
      case 'countdown':
        return <CountdownScreen />;
      case 'racing':
        return <RaceScreen />;
      case 'results':
        return <ResultsScreen />;
    }
  }
}
