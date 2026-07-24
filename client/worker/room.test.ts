import type {
  ApiErrorResponse,
  CreateRoomResponse,
  JoinRoomResponse,
  ServerMessage,
} from '@wikispeedrun/shared';
import { env } from 'cloudflare:workers';
import { evictDurableObject, reset, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, test } from 'vitest';
import { ROOM_STORAGE_KEY, parseRoomSnapshot } from './snapshot.js';

const JOIN_ATTEMPT_ID = '9e2a5f17-b57f-4ee9-9a7d-b4ae8f2dd1b2';

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
    const error = waitForMessage(socket);
    const closed = waitForClose(socket);
    socket.send(
      JSON.stringify({
        type: 'room/connect',
        playerId: created.playerId,
        rejoinCredential: `${created.rejoinCredential}-wrong`,
      }),
    );

    await expect(error).resolves.toEqual({
      type: 'room/error',
      code: 'invalid-membership',
      message: 'The Room Membership is invalid.',
    });
    expect((await closed).code).toBe(4003);
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

  test('promotes a reserved join before broadcasting the two-player lobby', async () => {
    const host = await createRoom('Host');
    const hostSocket = await connectRoomSocket(host);
    const guest = await joinRoom(host.roomCode, 'Guest');
    const reserved = parseRoomSnapshot(
      await runInDurableObject(env.ROOMS.getByName(host.roomCode), async (_instance, state) =>
        state.storage.get(ROOM_STORAGE_KEY),
      ),
    );
    expect(reserved.room.players).toHaveLength(1);
    expect(reserved.memberships[guest.playerId]).toBeUndefined();
    expect(reserved.joinAttempts[JOIN_ATTEMPT_ID]).toEqual(
      expect.objectContaining({ state: 'pending', playerId: guest.playerId, playerName: 'Guest' }),
    );

    const hostBroadcast = waitForMessage(hostSocket);
    const guestSocket = await connectRoomSocket(guest);
    const broadcast = await hostBroadcast;
    const stored = await runInDurableObject(
      env.ROOMS.getByName(host.roomCode),
      async (_instance, state) => state.storage.get(ROOM_STORAGE_KEY),
    );
    const snapshot = parseRoomSnapshot(stored);

    expect(broadcast).toEqual({
      type: 'room/sync',
      you: host.playerId,
      at: expect.any(Number),
      room: expect.objectContaining({
        players: [
          expect.objectContaining({ id: host.playerId, name: 'Host' }),
          expect.objectContaining({ id: guest.playerId, name: 'Guest' }),
        ],
      }),
    });
    expect(snapshot.room.players.map((player) => player.id)).toEqual([
      host.playerId,
      guest.playerId,
    ]);
    expect(snapshot.memberships[guest.playerId]?.credentialDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(guest.rejoinCredential);
    expect(snapshot.joinAttempts[JOIN_ATTEMPT_ID]).toEqual({
      state: 'promoted',
      playerId: guest.playerId,
    });
    guestSocket.close(1000, 'Test complete.');
    hostSocket.close(1000, 'Test complete.');
  });

  test('same join attempt survives response loss and eviction without a visible duplicate', async () => {
    const host = await createRoom('Host');
    const path = `https://example.test/api/rooms/${host.roomCode}/memberships`;
    const firstBody = JSON.stringify({
      playerName: 'Guest',
      attemptId: JOIN_ATTEMPT_ID,
      generation: 0,
    });
    const firstResponse = await SELF.fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: firstBody,
    });
    expect(firstResponse.status).toBe(201);
    const first = await firstResponse.json<JoinRoomResponse>();
    const stub = env.ROOMS.getByName(host.roomCode);

    await evictDurableObject(stub);
    const retryBody = JSON.stringify({
      playerName: 'Guest',
      attemptId: JOIN_ATTEMPT_ID,
      generation: 1,
    });
    const retriedResponse = await SELF.fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: retryBody,
    });
    expect(retriedResponse.status).toBe(201);
    const retried = await retriedResponse.json<JoinRoomResponse>();
    expect(retried.playerId).toBe(first.playerId);
    expect(retried.rejoinCredential).not.toBe(first.rejoinCredential);

    const reserved = parseRoomSnapshot(
      await runInDurableObject(stub, async (_instance, state) =>
        state.storage.get(ROOM_STORAGE_KEY),
      ),
    );
    expect(reserved.room.players.map((player) => player.id)).toEqual([host.playerId]);
    expect(reserved.memberships[retried.playerId]).toBeUndefined();
    expect(JSON.stringify(reserved)).not.toContain(first.rejoinCredential);
    expect(JSON.stringify(reserved)).not.toContain(retried.rejoinCredential);

    for (const generation of [0, 1]) {
      const stale = await SELF.fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerName: 'Guest', attemptId: JOIN_ATTEMPT_ID, generation }),
      });
      expect(stale.status).toBe(409);
    }

    const staleSocket = await openRoomSocket(host.roomCode);
    const staleError = waitForMessage(staleSocket);
    staleSocket.send(connectFrame(first));
    await expect(staleError).resolves.toEqual(
      expect.objectContaining({ type: 'room/error', code: 'invalid-membership' }),
    );

    const guestSocket = await connectRoomSocket(retried);
    const promoted = parseRoomSnapshot(
      await runInDurableObject(stub, async (_instance, state) =>
        state.storage.get(ROOM_STORAGE_KEY),
      ),
    );
    expect(promoted.room.players.filter((player) => player.id === retried.playerId)).toHaveLength(
      1,
    );
    expect(promoted.memberships[retried.playerId]).toBeDefined();

    const replay = await SELF.fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerName: 'Guest',
        attemptId: JOIN_ATTEMPT_ID,
        generation: 2,
      }),
    });
    expect(replay.status).toBe(409);
    const afterReplay = parseRoomSnapshot(
      await runInDurableObject(stub, async (_instance, state) =>
        state.storage.get(ROOM_STORAGE_KEY),
      ),
    );
    expect(
      afterReplay.room.players.filter((player) => player.id === retried.playerId),
    ).toHaveLength(1);
    guestSocket.close(1000, 'Test complete.');
  });

  test('a higher join generation wins before a late lower generation arrives', async () => {
    const host = await createRoom('Host');
    const path = `https://example.test/api/rooms/${host.roomCode}/memberships`;
    const newerResponse = await SELF.fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerName: 'Guest',
        attemptId: JOIN_ATTEMPT_ID,
        generation: 2,
      }),
    });
    expect(newerResponse.status).toBe(201);
    const newer = await newerResponse.json<JoinRoomResponse>();

    for (const generation of [0, 2]) {
      const stale = await SELF.fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerName: 'Guest', attemptId: JOIN_ATTEMPT_ID, generation }),
      });
      expect(stale.status).toBe(409);
    }

    const reserved = parseRoomSnapshot(
      await runInDurableObject(env.ROOMS.getByName(host.roomCode), async (_instance, state) =>
        state.storage.get(ROOM_STORAGE_KEY),
      ),
    );
    expect(reserved.joinAttempts[JOIN_ATTEMPT_ID]).toEqual(
      expect.objectContaining({
        state: 'pending',
        playerId: newer.playerId,
        generation: 2,
      }),
    );
    expect(reserved.room.players.map((player) => player.id)).toEqual([host.playerId]);

    const socket = await connectRoomSocket(newer);
    const promoted = parseRoomSnapshot(
      await runInDurableObject(env.ROOMS.getByName(host.roomCode), async (_instance, state) =>
        state.storage.get(ROOM_STORAGE_KEY),
      ),
    );
    expect(promoted.room.players.filter((player) => player.id === newer.playerId)).toHaveLength(1);
    socket.close(1000, 'Test complete.');
  });

  test('promotion survives the joining socket disappearing before its first sync is observed', async () => {
    const host = await createRoom('Host');
    const guest = await joinRoom(host.roomCode, 'Guest');
    const dropped = await openRoomSocket(host.roomCode);
    dropped.send(connectFrame(guest));
    dropped.close(1000, 'Dropped before observing first sync.');

    await expect
      .poll(async () => {
        const stored = await runInDurableObject(
          env.ROOMS.getByName(host.roomCode),
          async (_instance, state) => state.storage.get(ROOM_STORAGE_KEY),
        );
        return parseRoomSnapshot(stored).room.players.filter(
          (player) => player.id === guest.playerId,
        ).length;
      })
      .toBe(1);

    const recovered = await connectRoomSocket(guest);
    recovered.close(1000, 'Test complete.');
  });

  test('enforces the exact join boundary and reports an absent Room', async () => {
    const invalidBodies = [
      { playerName: 'Guest', extra: true },
      { playerName: 'Guest', attemptId: JOIN_ATTEMPT_ID },
      { playerName: 'Guest', attemptId: JOIN_ATTEMPT_ID, generation: -1 },
      { playerName: 'Guest', attemptId: JOIN_ATTEMPT_ID, generation: 0.5 },
    ];
    for (const body of invalidBodies) {
      const malformed = await SELF.fetch('https://example.test/api/rooms/ABCD/memberships', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(malformed.status).toBe(400);
      expect(malformed.headers.get('Cache-Control')).toBe('no-store');
      expect(await malformed.json<ApiErrorResponse>()).toEqual({
        error: {
          code: 'invalid-request',
          message:
            'Expected JSON with playerName, attemptId, and a non-negative integer generation.',
        },
      });
    }

    const absent = await SELF.fetch('https://example.test/api/rooms/ABCD/memberships', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerName: 'Guest',
        attemptId: JOIN_ATTEMPT_ID,
        generation: 0,
      }),
    });
    expect(absent.status).toBe(404);
    expect(await absent.json<ApiErrorResponse>()).toEqual({
      error: { code: 'room-not-found', message: 'No room found with that code.' },
    });
  });

  test('a public Player ID without its credential cannot take over a Membership', async () => {
    const host = await createRoom('Host');
    const guest = await joinRoom(host.roomCode, 'Guest');
    const socket = await openRoomSocket(host.roomCode);
    const error = waitForMessage(socket);
    const closed = waitForClose(socket);
    socket.send(
      JSON.stringify({
        type: 'room/connect',
        playerId: guest.playerId,
        rejoinCredential: host.rejoinCredential,
      }),
    );

    await expect(error).resolves.toEqual(
      expect.objectContaining({ type: 'room/error', code: 'invalid-membership' }),
    );
    expect((await closed).code).toBe(4003);
  });

  test('rejects non-exact and malformed authentication frames', async () => {
    const host = await createRoom('Host');
    const invalidFrames = [
      {
        type: 'room/connect',
        playerId: host.playerId,
        rejoinCredential: host.rejoinCredential,
        extra: true,
      },
      {
        type: 'room/connect',
        playerId: 'public-id',
        rejoinCredential: host.rejoinCredential,
      },
      {
        type: 'room/connect',
        playerId: host.playerId,
        rejoinCredential: 'not-a-credential',
      },
    ];

    for (const frame of invalidFrames) {
      const socket = await openRoomSocket(host.roomCode);
      const error = waitForMessage(socket);
      const closed = waitForClose(socket);
      socket.send(JSON.stringify(frame));
      await expect(error).resolves.toEqual(
        expect.objectContaining({ type: 'room/error', code: 'invalid-membership' }),
      );
      expect((await closed).code).toBe(4003);
    }
  });

  test('returns a committed Membership when a stale authenticated peer cannot receive broadcast', async () => {
    const host = await createRoom('Host');
    const stale = await connectRoomSocket(host);
    stale.close(1000, 'Peer left before join broadcast.');
    const guest = await joinRoom(host.roomCode, 'Guest');
    const guestSocket = await connectRoomSocket(guest);
    const stored = await runInDurableObject(
      env.ROOMS.getByName(host.roomCode),
      async (_instance, state) => state.storage.get(ROOM_STORAGE_KEY),
    );
    const snapshot = parseRoomSnapshot(stored);

    expect(snapshot.room.players.some((player) => player.id === guest.playerId)).toBe(true);
    expect(snapshot.memberships[guest.playerId]).toBeDefined();
    guestSocket.close(1000, 'Test complete.');
  });

  test('a newer authenticated socket replaces the old socket without changing identity', async () => {
    const host = await createRoom('Host');
    const first = await connectRoomSocket(host);
    const replacement = await openRoomSocket(host.roomCode);
    const oldError = waitForMessage(first);
    const oldClose = waitForClose(first);
    const replacementSync = waitForMessage(replacement);
    replacement.send(connectFrame(host));

    await expect(oldError).resolves.toEqual({
      type: 'room/error',
      code: 'connection-replaced',
      message: 'This Room Membership was opened in another tab.',
    });
    expect((await oldClose).code).toBe(4001);
    await expect(replacementSync).resolves.toEqual(
      expect.objectContaining({ type: 'room/sync', you: host.playerId }),
    );
    replacement.close(1000, 'Test complete.');
  });

  test('reclaims the same Membership after Durable Object eviction', async () => {
    const host = await createRoom('Host');
    const stub = env.ROOMS.getByName(host.roomCode);
    const first = await connectRoomSocket(host);
    await evictDurableObject(stub);

    const replacement = await openRoomSocket(host.roomCode);
    const oldError = waitForMessage(first);
    const replacementSync = waitForMessage(replacement);
    replacement.send(connectFrame(host));

    await expect(oldError).resolves.toEqual(
      expect.objectContaining({ type: 'room/error', code: 'connection-replaced' }),
    );
    const sync = await replacementSync;
    expect(sync).toEqual(expect.objectContaining({ type: 'room/sync', you: host.playerId }));
    replacement.close(1000, 'Test complete.');
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

async function joinRoom(roomCode: string, playerName: string): Promise<JoinRoomResponse> {
  const response = await SELF.fetch(`https://example.test/api/rooms/${roomCode}/memberships`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerName, attemptId: JOIN_ATTEMPT_ID, generation: 0 }),
  });
  expect(response.status).toBe(201);
  return response.json<JoinRoomResponse>();
}

async function connectRoomSocket(membership: CreateRoomResponse): Promise<WebSocket> {
  const socket = await openRoomSocket(membership.roomCode);
  const sync = waitForMessage(socket);
  socket.send(connectFrame(membership));
  await sync;
  return socket;
}

function connectFrame(membership: CreateRoomResponse): string {
  return JSON.stringify({
    type: 'room/connect',
    playerId: membership.playerId,
    rejoinCredential: membership.rejoinCredential,
  });
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
