import { INTENT_EVENT, MESSAGE_EVENT } from '@wikispeedrun/shared';
import { createServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import {
  createRoom,
  dispatch,
  getRoom,
  handleDisconnect,
  joinSocket,
  leaveSocket,
} from './shell/registry.js';
import { parseClientIntent } from './shell/validate.js';

const PORT = Number(process.env.PORT ?? 3001);

// Origins allowed to open a socket. Falls back to the Vite dev origin so local
// `pnpm dev` needs no env; set CLIENT_ORIGIN (comma-separated for several) when
// the client is deployed to a different origin than this server.
const CLIENT_ORIGIN = (process.env.CLIENT_ORIGIN ?? 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

const httpServer = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const io = new Server(httpServer, {
  cors: { origin: CLIENT_ORIGIN },
});

io.on('connection', (socket: Socket) => {
  socket.on(INTENT_EVENT, (raw: unknown) => {
    const intent = parseClientIntent(raw);
    if (!intent) return;
    const at = Date.now();

    if (intent.type === 'room/create') {
      if (socket.data.roomCode) return;
      const runtime = createRoom();
      joinSocket(runtime, socket, intent.playerId);
      if (!dispatch(runtime, { kind: 'client', playerId: intent.playerId, at, intent }, socket)) {
        leaveSocket(runtime, socket);
      }
      return;
    }

    if (intent.type === 'room/join') {
      if (socket.data.roomCode) return;
      const runtime = getRoom(intent.code);
      if (!runtime) {
        socket.emit(MESSAGE_EVENT, {
          type: 'room/error',
          code: 'room-not-found',
          message: 'No room found with that code.',
        });
        return;
      }
      joinSocket(runtime, socket, intent.playerId);
      if (!dispatch(runtime, { kind: 'client', playerId: intent.playerId, at, intent }, socket)) {
        leaveSocket(runtime, socket);
      }
      return;
    }

    const code = socket.data.roomCode as string | undefined;
    const playerId = socket.data.playerId as string | undefined;
    const runtime = code ? getRoom(code) : undefined;
    if (!runtime || !playerId) {
      socket.emit(MESSAGE_EVENT, {
        type: 'room/error',
        code: 'not-in-room',
        message: 'You are not in a room.',
      });
      return;
    }
    dispatch(runtime, { kind: 'client', playerId, at, intent }, socket);
  });

  socket.on('disconnect', () => handleDisconnect(socket));
});

httpServer.listen(PORT, () => {
  console.log(`wikispeedrun server listening on :${PORT}`);
});
