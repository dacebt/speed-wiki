import { FACES, HATS, MAX_PLAYERS, type PlayerView } from '@wikispeedrun/shared';
import { useState } from 'react';
import { useAppState } from '../../app/store';
import { Avatar } from '../../components/Avatar';
import { sendIntent } from '../../lib/socket';
import './lobby.css';

export function LobbyScreen() {
  const { room, you } = useAppState();
  const [hardMode, setHardMode] = useState(false);
  if (!room) return null;

  const me = room.players.find((p) => p.id === you);
  const isHost = me?.isHost ?? false;
  const hasScores = room.players.some((p) => p.score > 0);

  return (
    <main className="lobby">
      <header className="lobby__header">
        <h1 className="screen-title lobby__title">The Salon Assembles</h1>
        <div className="lobby__seal-wrap">
          <span className="label">Seal of the Salon</span>
          <span className="seal">{room.code}</span>
          <span className="flavor lobby__hint">Circulate the seal amongst thy friends.</span>
        </div>
      </header>

      <section className="panel panel--fleuron lobby__players">
        <span className="label">
          Learned company — {room.players.length} of {MAX_PLAYERS} seats taken
        </span>
        <ul className="lobby__list">
          {room.players.map((p) => (
            <PlayerCard key={p.id} player={p} isYou={p.id === you} showScore={hasScores} />
          ))}
        </ul>
      </section>

      {me && <CosmeticsPicker me={me} />}

      <section className="lobby__actions">
        {isHost ? (
          <>
            <label className="lobby__hardmode">
              <input
                type="checkbox"
                checked={hardMode}
                onChange={(e) => setHardMode(e.target.checked)}
              />
              <span>
                Hard mode <span className="flavor">— truly random pages, may the odds be dreadful</span>
              </span>
            </label>
            <button
              className="btn btn--primary lobby__start"
              onClick={() => sendIntent({ type: 'game/start', hardMode })}
            >
              Let the Pursuit of Knowledge Commence
            </button>
          </>
        ) : (
          <p className="flavor">Awaiting the host’s proclamation…</p>
        )}
      </section>
    </main>
  );
}

function PlayerCard({
  player,
  isYou,
  showScore,
}: {
  player: PlayerView;
  isYou: boolean;
  showScore: boolean;
}) {
  return (
    <li className="lobby__player">
      <Avatar cosmetics={player.cosmetics} />
      <div className="lobby__player-info">
        <span className="lobby__player-name">
          {player.name}
          {isYou && <span className="flavor"> (thee)</span>}
        </span>
        {player.isHost && <span className="label lobby__host">☞ Host of the Salon</span>}
        {showScore && <span className="lobby__score">{player.score} livres</span>}
      </div>
    </li>
  );
}

function CosmeticsPicker({ me }: { me: PlayerView }) {
  function pick(part: 'faceId' | 'hatId', id: string) {
    sendIntent({
      type: 'player/setCosmetics',
      cosmetics: { ...me.cosmetics, [part]: id },
    });
  }

  return (
    <section className="panel lobby__cosmetics">
      <span className="label">Commission thy portrait</span>
      <div className="lobby__cosmetic-row">
        {FACES.map((f) => (
          <button
            key={f.id}
            title={f.label}
            className={`lobby__swatch ${me.cosmetics.faceId === f.id ? 'lobby__swatch--active' : ''}`}
            onClick={() => pick('faceId', f.id)}
          >
            {f.glyph}
          </button>
        ))}
      </div>
      <div className="lobby__cosmetic-row">
        {HATS.map((h) => (
          <button
            key={h.id}
            title={h.label}
            className={`lobby__swatch ${me.cosmetics.hatId === h.id ? 'lobby__swatch--active' : ''}`}
            onClick={() => pick('hatId', h.id)}
          >
            {h.glyph === '' ? '∅' : h.glyph}
          </button>
        ))}
      </div>
    </section>
  );
}
