import { useEffect, useState } from 'react';
import { useAppState } from '../../app/store';
import { Avatar } from '../../components/Avatar';
import './countdown.css';

export function CountdownScreen() {
  const { room } = useAppState();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, []);

  if (!room) return null;

  const secondsLeft = Math.max(0, Math.ceil(((room.countdownEndsAt ?? 0) - now) / 1000));
  const flavor =
    secondsLeft > 6 ? 'Powder thy wig…' : secondsLeft > 3 ? 'Dip thy quill…' : 'GO FORTH!';

  return (
    <main className="countdown">
      <p className="flavor countdown__flavor">{flavor}</p>
      <div className="countdown__number">{secondsLeft}</div>
      <p className="flavor countdown__note">
        The pages are being chosen. All race from the same start to the same truth.
      </p>
      <div className="countdown__players">
        {room.players.map((p) => (
          <div key={p.id} className="countdown__player">
            <Avatar cosmetics={p.cosmetics} size="sm" />
            <span>{p.name}</span>
          </div>
        ))}
      </div>
    </main>
  );
}
