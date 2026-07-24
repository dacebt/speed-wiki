import { MAX_NAME_LENGTH, ROOM_CODE_LENGTH } from '@wikispeedrun/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { getPlayerName, setPlayerName } from '../../lib/identity';
import {
  claimStoredInvite,
  createRoom as createRoomThroughTransport,
  joinRoom as joinRoomThroughTransport,
  supportsInvitedJoining,
} from '../../lib/transport';
import { readInviteCode } from './inviteCode.js';
import './home.css';

/** Read a `?code=` invite param, normalized to the room-code shape. */
function readCodeParam(): string {
  return readInviteCode(window.location.search);
}

export function HomeScreen() {
  const [name, setName] = useState(getPlayerName);
  const [code, setCode] = useState(readCodeParam);
  const [submitting, setSubmitting] = useState<'create' | 'join' | null>(null);

  useEffect(() => {
    if (!supportsInvitedJoining) return;
    const params = new URLSearchParams(window.location.search);
    if (!params.has('code')) return;
    const invited = readCodeParam();
    const remembered = getPlayerName().trim();
    const nameValid = remembered.length > 0 && remembered.length <= MAX_NAME_LENGTH;
    if (invited.length === ROOM_CODE_LENGTH) {
      const claim = claimStoredInvite(invited);
      if (claim !== 'join') {
        if (claim === 'resume') consumeInviteParam(params);
        return;
      }
    }
    if (nameValid && invited.length === ROOM_CODE_LENGTH) {
      setSubmitting('join');
      void joinRoomThroughTransport(remembered, invited)
        .catch(() => undefined)
        .finally(() => {
          setSubmitting(null);
          consumeInviteParam(params);
        });
    }
  }, []);

  const trimmedName = name.trim();
  const nameOk = trimmedName.length > 0 && trimmedName.length <= MAX_NAME_LENGTH;

  async function createRoom() {
    if (!nameOk || submitting) return;
    setSubmitting('create');
    setPlayerName(trimmedName);
    try {
      await createRoomThroughTransport(trimmedName);
    } catch {
      // The transport publishes the terminal error through the normal notice path.
    } finally {
      setSubmitting(null);
      consumeInviteParam(new URLSearchParams(window.location.search));
    }
  }

  async function joinRoom(e: FormEvent) {
    e.preventDefault();
    if (!nameOk || code.trim().length !== ROOM_CODE_LENGTH || submitting) return;
    setSubmitting('join');
    setPlayerName(trimmedName);
    try {
      await joinRoomThroughTransport(trimmedName, code);
    } catch {
      // The transport publishes the terminal error through the normal notice path.
    } finally {
      setSubmitting(null);
      consumeInviteParam(new URLSearchParams(window.location.search));
    }
  }

  return (
    <main className="home">
      <header className="home__masthead">
        <h1 className="screen-title home__title">Wiki Speedrun</h1>
        <p className="flavor home__subtitle">
          Race your friends through Wikipedia links — first to the goal article wins.
        </p>
      </header>

      <div className="panel panel--fleuron home__card">
        <label className="label" htmlFor="player-name">
          Your name
        </label>
        <input
          id="player-name"
          className="input"
          value={name}
          maxLength={MAX_NAME_LENGTH}
          onChange={(e) => setName(e.target.value)}
          placeholder="Jane Doe"
          autoComplete="off"
        />

        <button
          className="btn btn--primary home__create"
          onClick={() => void createRoom()}
          disabled={!nameOk || submitting !== null}
          aria-busy={submitting === 'create'}
        >
          {submitting === 'create' ? 'Creating Room…' : 'Create a Room'}
        </button>

        {supportsInvitedJoining && (
          <>
            <div className="home__divider">
              <span className="flavor">— or —</span>
            </div>

            <form className="home__join" onSubmit={(event) => void joinRoom(event)}>
              <input
                className="input home__code"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="CODE"
                maxLength={ROOM_CODE_LENGTH}
                aria-label="Room code"
                autoComplete="off"
              />
              <button
                className="btn btn--quiet"
                type="submit"
                disabled={!nameOk || code.trim().length !== ROOM_CODE_LENGTH || submitting !== null}
                aria-busy={submitting === 'join'}
              >
                {submitting === 'join' ? 'Joining…' : 'Join Room'}
              </button>
            </form>
          </>
        )}
      </div>

      <footer className="flavor home__footer">Dare to know (and to click fast).</footer>
    </main>
  );
}

function consumeInviteParam(params: URLSearchParams): void {
  params.delete('code');
  const query = params.toString();
  window.history.replaceState(null, '', window.location.pathname + (query ? `?${query}` : ''));
}
