import { FACES, HATS, type PlayerView } from '@wikispeedrun/shared';
import { useEffect, useRef, useState } from 'react';
import { useAppState } from '../../app/store';
import { Avatar } from '../../components/Avatar';
import { sendIntent } from '../../lib/socket';
import './lobby.css';

export function LobbyScreen() {
  const { room, you } = useAppState();
  const [hardMode, setHardMode] = useState(false);
  const codeCopy = useCopyFeedback();
  const linkCopy = useCopyFeedback();
  if (!room) return null;

  const me = room.players.find((p) => p.id === you);
  const isHost = me?.isHost ?? false;
  const hasScores = room.players.some((p) => p.score > 0);
  const inviteUrl = `${window.location.origin}/?code=${room.code}`;

  return (
    <main className="lobby">
      <header className="lobby__header">
        <h1 className="screen-title lobby__title">Lobby</h1>
        <div className="lobby__seal-wrap">
          <span className="label">Room Code</span>
          <button
            type="button"
            className="seal seal--button"
            onClick={() => codeCopy.copy(room.code)}
            title="Copy room code"
            aria-label={`Copy room code ${room.code}`}
          >
            {room.code}
          </button>
          <span className="flavor lobby__hint" aria-live="polite">
            {codeCopy.copied ? 'Copied!' : '⧉ Click the seal to copy the code'}
          </span>
          <button
            type="button"
            className="btn btn--quiet lobby__copy-link"
            onClick={() => linkCopy.copy(inviteUrl)}
          >
            {linkCopy.copied ? 'Copied' : 'Copy invite link'}
          </button>
        </div>
      </header>

      <section className="panel panel--fleuron lobby__players">
        <span className="label">
          {room.players.length} {room.players.length === 1 ? 'player' : 'players'}
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
                Hard mode <span className="flavor">— truly random pages, may the odds be ever grim</span>
              </span>
            </label>
            <button
              className="btn btn--primary lobby__start"
              onClick={() => sendIntent({ type: 'game/start', hardMode })}
            >
              Start Game
            </button>
          </>
        ) : (
          <p className="flavor">Waiting for the host to start…</p>
        )}
      </section>
    </main>
  );
}

// Copy-to-clipboard with a brief "Copied" flash. On failure (API absent or
// permission denied) the copy is a no-op — the code stays selectable text, so
// there is nothing to crash and nothing to recover from.
function useCopyFeedback() {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable or denied; the value remains selectable.
    }
  }

  return { copied, copy };
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
          {isYou && <span className="flavor"> (you)</span>}
        </span>
        {player.isHost && <span className="label lobby__host">Host</span>}
        {showScore && <span className="lobby__score">{player.score} points</span>}
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
      <span className="label">Choose your portrait</span>
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
