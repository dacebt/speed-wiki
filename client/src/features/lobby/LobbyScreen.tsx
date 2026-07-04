import {
  FACES,
  HATS,
  type Category,
  type Difficulty,
  type PlayerView,
  type RoomSettings,
} from '@wikispeedrun/shared';
import { useEffect, useRef, useState } from 'react';
import { useAppState } from '../../app/store';
import { Avatar } from '../../components/Avatar';
import { sendIntent } from '../../lib/socket';
import './lobby.css';

export function LobbyScreen() {
  const { room, you } = useAppState();
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
            <PlayerCard
              key={p.id}
              player={p}
              isYou={p.id === you}
              showScore={hasScores}
              canKick={isHost && p.id !== you}
            />
          ))}
        </ul>
      </section>

      {me && <CosmeticsPicker me={me} />}

      <RoundSettings settings={room.settings} isHost={isHost} />

      <section className="lobby__actions">
        {isHost ? (
          <button
            className="btn btn--primary lobby__start"
            onClick={() => sendIntent({ type: 'game/start' })}
          >
            Start Game
          </button>
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
  canKick,
}: {
  player: PlayerView;
  isYou: boolean;
  showScore: boolean;
  canKick: boolean;
}) {
  return (
    <li className={`lobby__player ${player.away ? 'lobby__player--away' : ''}`}>
      <Avatar cosmetics={player.cosmetics} />
      <div className="lobby__player-info">
        <span className="lobby__player-name">
          {player.name}
          {isYou && <span className="flavor"> (you)</span>}
        </span>
        {player.isHost && <span className="label lobby__host">Host</span>}
        {player.away && <span className="flavor lobby__away">reconnecting…</span>}
        {showScore && <span className="lobby__score">{player.score} points</span>}
      </div>
      {canKick && (
        <button
          className="lobby__kick"
          aria-label={`Remove ${player.name}`}
          onClick={() => sendIntent({ type: 'room/kick', playerId: player.id })}
        >
          Remove
        </button>
      )}
    </li>
  );
}

const ROUND_PRESETS = [
  { label: '3 min', value: 3 * 60_000 },
  { label: '5 min', value: 5 * 60_000 },
  { label: '10 min', value: 10 * 60_000 },
] as const;

const COUNTDOWN_PRESETS = [
  { label: '5s', value: 5_000 },
  { label: '10s', value: 10_000 },
] as const;

const DIFFICULTY_PRESETS: readonly { label: string; value: Difficulty }[] = [
  { label: 'Curated', value: 'curated' },
  { label: 'Random', value: 'random' },
];

const CATEGORY_PRESETS: readonly { label: string; value: Category }[] = [
  { label: 'Any', value: 'any' },
  { label: 'Science', value: 'science' },
  { label: 'History', value: 'history' },
  { label: 'Geography', value: 'geography' },
  { label: 'Pop culture', value: 'pop-culture' },
];

// Every player sees the chosen setup; only the host can change it. The host sends
// just the changed knob — the core merges it — so quick successive edits can't
// clobber each other by shipping a full object built from a stale render.
function RoundSettings({ settings, isHost }: { settings: RoomSettings; isHost: boolean }) {
  function choose(patch: Partial<RoomSettings>) {
    sendIntent({ type: 'room/setSettings', settings: patch });
  }

  // Random draws from all of Wikipedia, so a category can't constrain it — the
  // picker is disabled under random to keep the combination honest.
  const categoryApplies = settings.difficulty !== 'random';

  return (
    <section className="panel lobby__settings">
      <span className="label">Round settings</span>
      <SettingRow
        name="Round length"
        presets={ROUND_PRESETS}
        current={settings.roundDurationMs}
        disabled={!isHost}
        onPick={(ms) => choose({ roundDurationMs: ms })}
      />
      <SettingRow
        name="Countdown"
        presets={COUNTDOWN_PRESETS}
        current={settings.countdownMs}
        disabled={!isHost}
        onPick={(ms) => choose({ countdownMs: ms })}
      />
      <SettingRow
        name="Difficulty"
        presets={DIFFICULTY_PRESETS}
        current={settings.difficulty}
        disabled={!isHost}
        onPick={(d) => choose({ difficulty: d })}
      />
      <SettingRow
        name="Category"
        presets={CATEGORY_PRESETS}
        current={settings.category}
        disabled={!isHost || !categoryApplies}
        onPick={(c) => choose({ category: c })}
      />
      <span className="flavor lobby__settings-hint">
        {settings.difficulty === 'random'
          ? 'Random draws two true-random pages and ignores the category — may the odds be ever grim.'
          : 'Curated draws a themed, winnable pair; “Any” uses the whole pool.'}
        {!isHost && ' The host sets the pace.'}
      </span>
    </section>
  );
}

function SettingRow<T extends string | number>({
  name,
  presets,
  current,
  disabled,
  onPick,
}: {
  name: string;
  presets: readonly { label: string; value: T }[];
  current: T;
  disabled: boolean;
  onPick: (value: T) => void;
}) {
  return (
    <div className="lobby__setting">
      <span className="lobby__setting-name">{name}</span>
      <div className="lobby__preset-row">
        {presets.map((p) => (
          <button
            key={p.value}
            className={`lobby__preset ${current === p.value ? 'lobby__preset--active' : ''}`}
            disabled={disabled}
            onClick={() => onPick(p.value)}
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
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
