import type { PlayerView } from '@wikispeedrun/shared';
import { useAppState } from '../../app/store';
import { Avatar } from '../../components/Avatar';
import { sendIntent } from '../../lib/socket';
import './results.css';

export function ResultsScreen() {
  const { room, you } = useAppState();
  if (!room?.round) return null;

  const me = room.players.find((p) => p.id === you);
  const ordered = [...room.players].sort(compareStanding);
  const winner = ordered[0]?.finishedRank === 1 ? ordered[0] : null;

  return (
    <main className="results">
      <header className="results__header">
        <span className="label">Round {room.round.roundNumber} — {room.round.startArticle} ☞ {room.round.goalArticle}</span>
        <h1 className="screen-title results__title">
          {winner ? 'Enlightenment Achieved' : 'The Hour Has Struck'}
        </h1>
        {winner ? (
          <p className="flavor results__proclamation">
            {winner.name}, first to the truth. The salon applauds.
          </p>
        ) : (
          <p className="flavor results__proclamation">None reached the goal. The salon pretends not to notice.</p>
        )}
      </header>

      <section className="panel panel--fleuron results__table-wrap">
        <table className="results__table">
          <thead>
            <tr>
              <th className="label">Standing</th>
              <th className="label">Philosophe</th>
              <th className="label">Leaps</th>
              <th className="label">Time</th>
              <th className="label">Livres Earned</th>
              <th className="label">Fortune</th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((p, i) => (
              <tr key={p.id} className={p.id === you ? 'results__row--you' : ''}>
                <td className="results__standing">{standingLabel(p)}</td>
                <td>
                  <span className="results__player">
                    <Avatar cosmetics={p.cosmetics} size="sm" />
                    <span>
                      <span className="results__name">{p.name}</span>
                      <span className="flavor results__path" title={p.path.join(' → ')}>
                        {pathSummary(p, i)}
                      </span>
                    </span>
                  </span>
                </td>
                <td>{p.finishedRank !== null ? p.clicks : '—'}</td>
                <td>{p.finishedAfterMs !== null ? formatMs(p.finishedAfterMs) : '—'}</td>
                <td className="results__points">{p.roundPoints > 0 ? `+${p.roundPoints}` : '0'}</td>
                <td className="results__fortune">{p.score}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {me?.isHost ? (
        <button className="btn btn--primary results__again" onClick={() => sendIntent({ type: 'game/playAgain' })}>
          Another Round, for Honour
        </button>
      ) : (
        <p className="flavor">The host deliberates on another round…</p>
      )}
    </main>
  );
}

function compareStanding(a: PlayerView, b: PlayerView): number {
  const rank = (p: PlayerView) => p.finishedRank ?? Infinity;
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (a.gaveUp !== b.gaveUp) return a.gaveUp ? 1 : -1;
  return b.clicks - a.clicks;
}

function standingLabel(p: PlayerView): string {
  if (p.finishedRank === 1) return '🏆 1st';
  if (p.finishedRank !== null) return `${ordinal(p.finishedRank)}`;
  if (p.gaveUp) return 'Withdrew';
  return 'Lost in the stacks';
}

function pathSummary(p: PlayerView, index: number): string {
  if (p.finishedRank !== null) return p.path.join(' → ');
  if (p.gaveUp) return 'departed with dignity';
  return index > 0 ? 'arrives fashionably late, as is their custom' : 'never found the way';
}

function formatMs(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function ordinal(n: number): string {
  const suffix = n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th';
  return `${n}${suffix}`;
}
