import type { PlayerView } from '@wikispeedrun/shared';
import { useEffect, useRef, useState } from 'react';
import { useAppDispatch, useAppState } from '../../app/store';
import { Avatar } from '../../components/Avatar';
import { sendIntent } from '../../lib/socket';
import { ArticlePane } from './viewer/ArticlePane';
import './race.css';

export function RaceScreen() {
  const { room, you } = useAppState();
  const dispatch = useAppDispatch();
  const [currentTitle, setCurrentTitle] = useState(() => room?.round?.startArticle ?? '');
  // Whether the next arrival is a hop to report (initial round load is not).
  const hopPendingRef = useRef(false);

  const me = room?.players.find((p) => p.id === you);
  const frozen = (me?.finishedRank ?? null) !== null || (me?.gaveUp ?? false);

  if (!room?.round || !me) return null;
  const round = room.round;

  function handleNavigate(title: string) {
    hopPendingRef.current = true;
    setCurrentTitle(title);
  }

  function handleArrived(canonicalTitle: string) {
    if (!hopPendingRef.current) return;
    hopPendingRef.current = false;
    sendIntent({ type: 'race/hop', article: canonicalTitle });
  }

  function handleBlocked() {
    dispatch({
      type: 'server/message',
      message: {
        type: 'room/error',
        code: 'wrong-phase',
        message: 'That path leads out of the Encyclopédie. Out of bounds.',
      },
      receivedAt: Date.now(),
    });
  }

  return (
    <main className="race">
      <WagerBoard players={room.players} you={you} deadline={round.deadline} myClicks={me.clicks} />

      <section className="race__stage">
        <header className="race__plate panel">
          <div className="race__route">
            <span className="label race__route-label">From</span>
            <span className="race__route-title">{round.startArticle}</span>
            <span className="race__manicule">☞</span>
            <span className="label race__route-label">Toward</span>
            <span className="race__route-title race__route-title--goal">{round.goalArticle}</span>
          </div>
          <div className="race__trail flavor">{me.path.join(' → ')}</div>
        </header>

        <div className="race__pane-wrap">
          <ArticlePane
            title={currentTitle}
            onArrived={handleArrived}
            onNavigate={handleNavigate}
            onBlocked={handleBlocked}
            frozen={frozen}
          />
          {frozen && (
            <div className="race__done-overlay">
              <div className="panel panel--fleuron race__done-card">
                {me.finishedRank !== null ? (
                  <>
                    <h2 className="screen-title race__done-title">Enlightenment Achieved</h2>
                    <p className="flavor">
                      Thou hast reached <strong>{round.goalArticle}</strong> in {me.clicks} leaps —
                      position {me.finishedRank}. The salon awaits the stragglers.
                    </p>
                  </>
                ) : (
                  <>
                    <h2 className="screen-title race__done-title">The Wager Is Conceded</h2>
                    <p className="flavor">A dignified retreat. The salon murmurs approvingly.</p>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

function WagerBoard({
  players,
  you,
  deadline,
  myClicks,
}: {
  players: PlayerView[];
  you: string | null;
  deadline: number;
  myClicks: number;
}) {
  const ordered = [...players].sort(compareProgress);
  return (
    <aside className="race__board">
      <div className="panel race__cartouche">
        <div className="race__stat">
          <span className="label">Leaps</span>
          <span className="race__stat-value">{myClicks}</span>
        </div>
        <div className="race__stat">
          <span className="label">The Hour</span>
          <span className="race__stat-value race__stat-value--timer">
            <TimeLeft deadline={deadline} />
          </span>
        </div>
      </div>

      <div className="panel race__gossip">
        <span className="label">The Wager Board</span>
        <ul className="race__players">
          {ordered.map((p) => (
            <li key={p.id} className={`race__player ${p.id === you ? 'race__player--you' : ''}`}>
              <Avatar cosmetics={p.cosmetics} size="sm" />
              <div className="race__player-info">
                <span className="race__player-name">
                  {p.finishedRank !== null && <span className="race__medal">🕯️ {ordinal(p.finishedRank)}</span>}{' '}
                  {p.name}
                </span>
                <span className="flavor race__player-status">{playerStatus(p)}</span>
              </div>
              <span className="race__player-clicks">{p.clicks}</span>
            </li>
          ))}
        </ul>
      </div>

      <button className="btn btn--quiet race__giveup" onClick={() => sendIntent({ type: 'race/giveUp' })}>
        Concede the Wager
      </button>
    </aside>
  );
}

function compareProgress(a: PlayerView, b: PlayerView): number {
  const rank = (p: PlayerView) => p.finishedRank ?? Infinity;
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (a.gaveUp !== b.gaveUp) return a.gaveUp ? 1 : -1;
  return b.clicks - a.clicks;
}

function playerStatus(p: PlayerView): string {
  if (p.finishedRank !== null) return `arrived in ${p.clicks} leaps`;
  if (p.gaveUp) return 'has withdrawn from the wager';
  const current = p.path[p.path.length - 1];
  return current ? `presently reading ${current}` : 'composing themselves';
}

function ordinal(n: number): string {
  const suffix = n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th';
  return `${n}${suffix}`;
}

function TimeLeft({ deadline }: { deadline: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);
  const left = Math.max(0, deadline - now);
  const minutes = Math.floor(left / 60_000);
  const seconds = Math.floor((left % 60_000) / 1000);
  return <>{minutes}:{String(seconds).padStart(2, '0')}</>;
}
