// Socket smoke: drives the host-kick flow against a running server (:3001).
// Covers the happy path (kick + rejoin) and every rejection branch. Exits
// non-zero on the first failed expectation.
//
//   pnpm --filter server dev        # in one terminal
//   pnpm --filter server smoke      # in another

import { io } from 'socket.io-client';

const URL = process.env.SMOKE_URL ?? 'http://localhost:3001';
const INTENT_EVENT = 'intent';
const MESSAGE_EVENT = 'message';

let failures = 0;
function check(cond, label) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    console.error(`  FAIL ${label}`);
    failures += 1;
  }
}

function connect() {
  const socket = io(URL, { transports: ['websocket'], forceNew: true });
  const inbox = [];
  const waiters = [];
  socket.on(MESSAGE_EVENT, (msg) => {
    const i = waiters.findIndex((w) => w.match(msg));
    if (i !== -1) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  socket.send = (intent) => socket.emit(INTENT_EVENT, intent);
  socket.next = (match, label) =>
    new Promise((resolve, reject) => {
      const i = inbox.findIndex(match);
      if (i !== -1) return resolve(inbox.splice(i, 1)[0]);
      const timer = setTimeout(() => {
        const idx = waiters.indexOf(waiter);
        if (idx !== -1) waiters.splice(idx, 1);
        reject(new Error(`timed out waiting for ${label}`));
      }, 3000);
      const waiter = { match, resolve: (m) => (clearTimeout(timer), resolve(m)) };
      waiters.push(waiter);
    });
  return socket;
}

const isSync = (m) => m.type === 'room/sync';
const isError = (code) => (m) => m.type === 'room/error' && m.code === code;

async function main() {
  const host = connect();
  const guest = connect();
  await Promise.all([
    new Promise((r) => host.on('connect', r)),
    new Promise((r) => guest.on('connect', r)),
  ]);

  // Host creates a room.
  host.send({ type: 'room/create', playerName: 'Host' });
  const created = await host.next(isSync, 'host room/sync');
  const code = created.room.code;
  const hostId = created.you;
  check(created.room.players.length === 1, 'room starts with host only');

  // Guest joins.
  guest.send({ type: 'room/join', code, playerName: 'Guest' });
  const joined = await guest.next(isSync, 'guest room/sync');
  const guestId = joined.you;
  check(joined.room.players.length === 2, 'guest join → 2 players');
  await host.next((m) => isSync(m) && m.room.players.length === 2, 'host sees 2 players');

  // Rejection: a non-host cannot kick.
  guest.send({ type: 'room/kick', playerId: hostId });
  const notHost = await guest.next(isError('not-host'), 'non-host kick → not-host');
  check(notHost.code === 'not-host', 'non-host kick rejected not-host');

  // Rejection: unknown target.
  host.send({ type: 'room/kick', playerId: 'nobody' });
  check(
    (await host.next(isError('not-in-room'), 'unknown target')).code === 'not-in-room',
    'unknown target rejected',
  );

  // Rejection: host cannot kick themselves.
  host.send({ type: 'room/kick', playerId: hostId });
  check(
    (await host.next(isError('not-in-room'), 'self kick')).code === 'not-in-room',
    'self kick rejected',
  );

  // Happy path: host kicks the guest.
  host.send({ type: 'room/kick', playerId: guestId });
  const kicked = await guest.next(isError('kicked'), 'guest kicked notice');
  check(kicked.code === 'kicked', 'kicked player receives kicked notice');
  const afterKick = await host.next(
    (m) => isSync(m) && m.room.players.length === 1,
    'host lobby drops the guest',
  );
  check(!afterKick.room.players.some((p) => p.id === guestId), 'host lobby no longer lists guest');

  // Rejoin: the kicked player can come back with the same code.
  guest.send({ type: 'room/join', code, playerName: 'Guest' });
  const rejoined = await guest.next(isSync, 'guest rejoin');
  check(rejoined.room.players.length === 2, 'kicked player can rejoin');
  await host.next((m) => isSync(m) && m.room.players.length === 2, 'host sees rejoin');

  // Rejection: no kicking once the lobby is left (countdown counts as underway).
  host.send({ type: 'game/start', hardMode: false });
  await host.next((m) => isSync(m) && m.room.phase === 'countdown', 'countdown started');
  const rejoinedGuestId = rejoined.you;
  host.send({ type: 'room/kick', playerId: rejoinedGuestId });
  check(
    (await host.next(isError('wrong-phase'), 'kick in countdown')).code === 'wrong-phase',
    'kick outside lobby rejected wrong-phase',
  );

  host.close();
  guest.close();
}

main()
  .then(() => {
    console.log(failures === 0 ? '\nsmoke passed' : `\nsmoke FAILED (${failures})`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error('\nsmoke errored:', err.message);
    process.exit(1);
  });
