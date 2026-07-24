import type { CreateRoomResponse, ServerMessage } from '@wikispeedrun/shared';
import { env } from 'cloudflare:workers';
import { evictDurableObject, reset, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, test } from 'vitest';
import { ROOM_STORAGE_KEY, parseRoomSnapshot } from './snapshot.js';

afterEach(() => reset());

describe('Cloudflare Room creation boundary', () => {
  test('persists a single server-issued host membership before returning', async () => {
    const created = await createRoom('Ada');
    const stub = env.ROOMS.getByName(created.roomCode);
    const stored = await runInDurableObject(stub, async (_instance, state) =>
      state.storage.get(ROOM_STORAGE_KEY),
    );
    const snapshot = parseRoomSnapshot(stored);

    expect(snapshot.room.code).toBe(created.roomCode);
    expect(snapshot.room.phase).toBe('lobby');
    expect(snapshot.room.players).toEqual([
      expect.objectContaining({ id: created.playerId, name: 'Ada', isHost: true }),
    ]);
    expect(snapshot.memberships[created.playerId]?.credentialDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(created.rejoinCredential);
  });

  test('rejects an invalid Membership credential', async () => {
    const created = await createRoom('Grace');
    const socket = await openRoomSocket(created.roomCode);
    socket.send(
      JSON.stringify({
        type: 'room/connect',
        playerId: created.playerId,
        rejoinCredential: `${created.rejoinCredential}-wrong`,
      }),
    );

    const closed = await waitForClose(socket);
    expect(closed.code).toBe(1008);
  });

  test('authenticates the first frame and sends the complete lobby sync', async () => {
    const created = await createRoom('Lin');
    const socket = await openRoomSocket(created.roomCode);
    socket.send(
      JSON.stringify({
        type: 'room/connect',
        playerId: created.playerId,
        rejoinCredential: created.rejoinCredential,
      }),
    );

    const message = await waitForMessage(socket);
    expect(message).toEqual({
      type: 'room/sync',
      you: created.playerId,
      at: expect.any(Number),
      room: expect.objectContaining({
        code: created.roomCode,
        phase: 'lobby',
        players: [expect.objectContaining({ id: created.playerId, isHost: true })],
      }),
    });
    socket.close(1000, 'Test complete.');
  });

  test('restores authenticated WebSocket attachments after Durable Object eviction', async () => {
    const created = await createRoom('Margaret');
    const stub = env.ROOMS.getByName(created.roomCode);
    const socket = await openRoomSocket(created.roomCode);
    socket.send(
      JSON.stringify({
        type: 'room/connect',
        playerId: created.playerId,
        rejoinCredential: created.rejoinCredential,
      }),
    );
    const sync = await waitForMessage(socket);
    expect(sync.type).toBe('room/sync');

    await evictDurableObject(stub);
    socket.send(JSON.stringify({ type: 'game/start' }));
    const response = await waitForMessage(socket);

    expect(response).toEqual({
      type: 'room/error',
      code: 'room-unavailable',
      message: 'This Room action is not available in the current migration slice.',
    });
    socket.close(1000, 'Test complete.');
  });
});

async function createRoom(playerName: string): Promise<CreateRoomResponse> {
  const response = await SELF.fetch('https://example.test/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerName }),
  });
  expect(response.status).toBe(201);
  return response.json<CreateRoomResponse>();
}

async function openRoomSocket(roomCode: string): Promise<WebSocket> {
  const response = await SELF.fetch(`https://example.test/api/rooms/${roomCode}/websocket`, {
    headers: { Upgrade: 'websocket' },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  expect(socket).not.toBeNull();
  socket!.accept();
  return socket!;
}

function waitForMessage(socket: WebSocket): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    socket.addEventListener(
      'message',
      (event) => {
        try {
          resolve(JSON.parse(String(event.data)) as ServerMessage);
        } catch (error) {
          reject(error);
        }
      },
      { once: true },
    );
  });
}

function waitForClose(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve) => {
    socket.addEventListener('close', resolve, { once: true });
  });
}
