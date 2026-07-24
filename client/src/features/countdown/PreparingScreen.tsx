import { useAppState } from '../../app/store';
import { Avatar } from '../../components/Avatar';
import './countdown.css';

export function PreparingScreen() {
  const { room } = useAppState();
  if (!room) return null;

  return (
    <main className="countdown">
      <p className="flavor countdown__flavor">Preparing the course…</p>
      <h1 className="screen-title">Choosing articles</h1>
      <p className="flavor countdown__note">
        Everyone will receive the same start and goal before the countdown begins.
      </p>
      <div className="countdown__players">
        {room.players.map((player) => (
          <div key={player.id} className="countdown__player">
            <Avatar cosmetics={player.cosmetics} size="sm" />
            <span>{player.name}</span>
          </div>
        ))}
      </div>
    </main>
  );
}
