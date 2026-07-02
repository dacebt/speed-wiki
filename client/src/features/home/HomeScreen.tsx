import { MAX_NAME_LENGTH, ROOM_CODE_LENGTH } from '@wikispeedrun/shared';
import { useState, type FormEvent } from 'react';
import { sendIntent } from '../../lib/socket';
import './home.css';

const NAME_STORAGE_KEY = 'wikispeedrun.playerName';

export function HomeScreen() {
  const [name, setName] = useState(() => localStorage.getItem(NAME_STORAGE_KEY) ?? '');
  const [code, setCode] = useState('');

  const trimmedName = name.trim();
  const nameOk = trimmedName.length > 0 && trimmedName.length <= MAX_NAME_LENGTH;

  function rememberName() {
    localStorage.setItem(NAME_STORAGE_KEY, trimmedName);
  }

  function createRoom() {
    if (!nameOk) return;
    rememberName();
    sendIntent({ type: 'room/create', playerName: trimmedName });
  }

  function joinRoom(e: FormEvent) {
    e.preventDefault();
    if (!nameOk || code.trim().length !== ROOM_CODE_LENGTH) return;
    rememberName();
    sendIntent({ type: 'room/join', code: code.trim().toUpperCase(), playerName: trimmedName });
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
        <label className="label" htmlFor="player-name">Your name</label>
        <input
          id="player-name"
          className="input"
          value={name}
          maxLength={MAX_NAME_LENGTH}
          onChange={(e) => setName(e.target.value)}
          placeholder="Jane Doe"
          autoComplete="off"
        />

        <button className="btn btn--primary home__create" onClick={createRoom} disabled={!nameOk}>
          Create a Room
        </button>

        <div className="home__divider">
          <span className="flavor">— or —</span>
        </div>

        <form className="home__join" onSubmit={joinRoom}>
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
            disabled={!nameOk || code.trim().length !== ROOM_CODE_LENGTH}
          >
            Join Room
          </button>
        </form>
      </div>

      <footer className="flavor home__footer">Dare to know (and to click fast).</footer>
    </main>
  );
}
