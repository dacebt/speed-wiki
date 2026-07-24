import type {
  ApiErrorResponse,
  CreateRoomResponse,
  JoinRoomResponse,
  ServerMessage,
} from '@wikispeedrun/shared';
import {
  MEMBERSHIP_MESSAGE_RATE_LIMIT,
  ROOM_MEMBERSHIP_LIMIT,
  WEBSOCKET_MESSAGE_BYTE_LIMIT,
} from '@wikispeedrun/shared';
import { env } from 'cloudflare:workers';
import { evictDurableObject, reset, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { expireMembershipGrace } from './roomPresence.js';
import { MEMBERSHIP_GRACE_MS, type MembershipGraceDeadline } from './roomSchedule.js';
import { ROOM_STORAGE_KEY, parseRoomSnapshot } from './snapshot.js';

const JOIN_ATTEMPT_ID = '9e2a5f17-b57f-4ee9-9a7d-b4ae8f2dd1b2';
const SECOND_JOIN_ATTEMPT_ID = '2297ac68-da58-4cad-94ae-e5f863beab60';

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

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
      expect.objectContaining({ id: created.playerId, name: 'Ada', isHost: true, away: true }),
    ]);
    expect(snapshot.memberships[created.playerId]).toEqual({
      credentialDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      activeConnectionId: null,
      messageWindow: { startedAt: 0, count: 0 },
    });
    expect(snapshot.deadlines).toEqual([
      {
        kind: 'membership-grace',
        playerId: created.playerId,
        connectionId: null,
        at: expect.any(Number),
      },
    ]);
    expect(JSON.stringify(stored)).not.toContain(created.rejoinCredential);
  });

  test('expires an abandoned creation, returns 404, and permits the exact code to be claimed again', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const created = await createRoom('Cancelled Host');
    const stub = env.ROOMS.getByName(created.roomCode);
    const before = parseRoomSnapshot(
      await runInDurableObject(stub, async (_instance, state) =>
        state.storage.get(ROOM_STORAGE_KEY),
      ),
    );
    expect(before.deadlines[0]?.at).toBe(1_000 + MEMBERSHIP_GRACE_MS);

    clock.mockReturnValue(1_000 + MEMBERSHIP_GRACE_MS);
    await runInDurableObject(stub, async (instance) => instance.alarm());
    expect(
      await runInDurableObject(stub, async (_instance, state) =>
        state.storage.get(ROOM_STORAGE_KEY),
      ),
    ).toBeUndefined();
    expect(
      await runInDurableObject(stub, async (_instance, state) => state.storage.getAlarm()),
    ).toBeNull();
    const absent = await SELF.fetch(
      `https://example.test/api/rooms/${created.roomCode}/websocket`,
      { headers: { Upgrade: 'websocket' } },
    );
    expect(absent.status).toBe(404);
    const absentMembership = await SELF.fetch(
      `https://example.test/api/rooms/${created.roomCode}/memberships`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerName: 'Guest',
          attemptId: JOIN_ATTEMPT_ID,
          generation: 0,
        }),
      },
    );
    expect(absentMembership.status).toBe(404);

    const reclaimed = await stub.createRoom(created.roomCode, 'Next Host');
    expect(reclaimed).toEqual(expect.objectContaining({ ok: true, roomCode: created.roomCode }));
  });

  test.each([
    ['one millisecond before', -1, true],
    ['exactly at', 0, false],
    ['one millisecond after', 1, false],
  ])(
    'initial host authentication %s the grace cutoff is accepted=%s',
    async (_label, offset, accepted) => {
      const base = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(base);
      const host = await createRoom('Host');
      const stub = env.ROOMS.getByName(host.roomCode);
      const before = parseRoomSnapshot(
        await runInDurableObject(stub, async (_instance, state) =>
          state.storage.get(ROOM_STORAGE_KEY),
        ),
      );
      const grace = before.deadlines[0]!;
      if (!accepted) {
        await runInDurableObject(stub, async (_instance, state) =>
          state.storage.setAlarm(grace.at + MEMBERSHIP_GRACE_MS),
        );
      }
      clock.mockReturnValue(grace.at + offset);

      if (accepted) {
        const socket = await connectRoomSocket(host);
        const restored = parseRoomSnapshot(
          await runInDurableObject(stub, async (_instance, state) =>
            state.storage.get(ROOM_STORAGE_KEY),
          ),
        );
        expect(restored.room.players[0]).toEqual(
          expect.objectContaining({ id: host.playerId, away: false }),
        );
        expect(restored.deadlines).toEqual([]);
        socket.close(1000, 'Test complete.');
        return;
      }

      const socket = await openRoomSocket(host.roomCode);
      const error = waitForMessage(socket);
      const closed = waitForClose(socket);
      socket.send(connectFrame(host));
      await expect(error).resolves.toEqual(
        expect.objectContaining({ type: 'room/error', code: 'invalid-membership' }),
      );
      expect((await closed).code).toBe(4003);
      const rejected = parseRoomSnapshot(
        await runInDurableObject(stub, async (_instance, state) =>
          state.storage.get(ROOM_STORAGE_KEY),
        ),
      );
      expect(rejected).toEqual(before);

      await runInDurableObject(stub, async (instance) => instance.alarm());
      expect(
        await runInDurableObject(stub, async (_instance, state) =>
          state.storage.get(ROOM_STORAGE_KEY),
        ),
      ).toBeUndefined();
    },
  );

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

  test('restores authenticated WebSocket attachments for Start after Durable Object eviction', async () => {
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

    expect(response).toEqual(
      expect.objectContaining({
        type: 'room/sync',
        room: expect.objectContaining({ phase: 'preparing' }),
      }),
    );
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
    expect(snapshot.memberships[guest.playerId]).toEqual({
      credentialDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      activeConnectionId: expect.any(String),
      messageWindow: { startedAt: expect.any(Number), count: 1 },
    });
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
    const hostSocket = await connectRoomSocket(host);
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
    hostSocket.close(1000, 'Test complete.');
  });

  test('a higher join generation wins before a late lower generation arrives', async () => {
    const host = await createRoom('Host');
    const hostSocket = await connectRoomSocket(host);
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
    hostSocket.close(1000, 'Test complete.');
  });

  test('promotion survives the joining socket disappearing before its first sync is observed', async () => {
    const host = await createRoom('Host');
    const hostSocket = await connectRoomSocket(host);
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
    hostSocket.close(1000, 'Test complete.');
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

  test('counts pending reservations toward eight slots, rejects the ninth, and permits an at-capacity retry', async () => {
    const host = await createRoom('Host');
    const path = `https://example.test/api/rooms/${host.roomCode}/memberships`;
    const attempts = [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000004',
      '00000000-0000-4000-8000-000000000005',
      '00000000-0000-4000-8000-000000000006',
      '00000000-0000-4000-8000-000000000007',
      '00000000-0000-4000-8000-000000000008',
    ];
    let eighthSlot: JoinRoomResponse | null = null;
    for (const [index, attemptId] of attempts.slice(0, ROOM_MEMBERSHIP_LIMIT - 1).entries()) {
      const response = await SELF.fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerName: `Guest ${index + 1}`,
          attemptId,
          generation: 0,
        }),
      });
      expect(response.status).toBe(201);
      eighthSlot = await response.json<JoinRoomResponse>();
    }

    const stub = env.ROOMS.getByName(host.roomCode);
    const atCapacity = parseRoomSnapshot(
      await runInDurableObject(stub, async (_instance, state) =>
        state.storage.get(ROOM_STORAGE_KEY),
      ),
    );
    expect(Object.keys(atCapacity.memberships)).toHaveLength(1);
    expect(
      Object.values(atCapacity.joinAttempts).filter((attempt) => attempt.state === 'pending'),
    ).toHaveLength(ROOM_MEMBERSHIP_LIMIT - 1);

    const rejected = await SELF.fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerName: 'Ninth Player',
        attemptId: attempts.at(-1),
        generation: 0,
      }),
    });
    expect(rejected.status).toBe(409);
    expect(await rejected.json<ApiErrorResponse>()).toEqual({
      error: { code: 'room-full', message: 'The Room is full.' },
    });
    expect(
      parseRoomSnapshot(
        await runInDurableObject(stub, async (_instance, state) =>
          state.storage.get(ROOM_STORAGE_KEY),
        ),
      ),
    ).toEqual(atCapacity);

    const retry = await SELF.fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerName: `Guest ${ROOM_MEMBERSHIP_LIMIT - 1}`,
        attemptId: attempts[ROOM_MEMBERSHIP_LIMIT - 2],
        generation: 1,
      }),
    });
    expect(retry.status).toBe(201);
    const retried = await retry.json<JoinRoomResponse>();
    expect(retried.playerId).toBe(eighthSlot!.playerId);
    expect(retried.rejoinCredential).not.toBe(eighthSlot!.rejoinCredential);
    const afterRetry = parseRoomSnapshot(
      await runInDurableObject(stub, async (_instance, state) =>
        state.storage.get(ROOM_STORAGE_KEY),
      ),
    );
    expect(Object.keys(afterRetry.memberships)).toHaveLength(1);
    expect(
      Object.values(afterRetry.joinAttempts).filter((attempt) => attempt.state === 'pending'),
    ).toHaveLength(ROOM_MEMBERSHIP_LIMIT - 1);
  });

  test.each(['utf8', 'binary'] as const)(
    'enforces the 4,096-byte frame boundary before parsing for %s frames',
    async (kind) => {
      const host = await createRoom('Host');
      const socket = await connectRoomSocket(host);
      const stub = env.ROOMS.getByName(host.roomCode);
      const accepted =
        kind === 'utf8'
          ? 'é'.repeat(WEBSOCKET_MESSAGE_BYTE_LIMIT / 2)
          : new Uint8Array(WEBSOCKET_MESSAGE_BYTE_LIMIT).buffer;
      const oversized =
        kind === 'utf8'
          ? `${'é'.repeat(WEBSOCKET_MESSAGE_BYTE_LIMIT / 2)}x`
          : new Uint8Array(WEBSOCKET_MESSAGE_BYTE_LIMIT + 1).buffer;

      const invalid = waitForMessage(socket);
      socket.send(accepted);
      await expect(invalid).resolves.toEqual(
        expect.objectContaining({ type: 'room/error', code: 'invalid-request' }),
      );
      const beforeOversized = parseRoomSnapshot(
        await runInDurableObject(stub, async (_instance, state) =>
          state.storage.get(ROOM_STORAGE_KEY),
        ),
      );
      expect(beforeOversized.memberships[host.playerId]!.messageWindow.count).toBe(2);

      const error = waitForMessage(socket);
      const closed = waitForClose(socket);
      socket.send(oversized);
      await expect(error).resolves.toEqual({
        type: 'room/error',
        code: 'message-too-large',
        message: 'Room messages may be at most 4,096 UTF-8 bytes.',
      });
      expect((await closed).code).toBe(1009);
      await expect
        .poll(async () => {
          const stored = await runInDurableObject(stub, async (_instance, state) =>
            state.storage.get(ROOM_STORAGE_KEY),
          );
          return parseRoomSnapshot(stored).room.players[0]?.away;
        })
        .toBe(true);
      const afterOversized = parseRoomSnapshot(
        await runInDurableObject(stub, async (_instance, state) =>
          state.storage.get(ROOM_STORAGE_KEY),
        ),
      );
      expect(afterOversized.room).toEqual({
        ...beforeOversized.room,
        players: [{ ...beforeOversized.room.players[0]!, away: true }],
      });
      expect(afterOversized.memberships[host.playerId]!.messageWindow).toEqual(
        beforeOversized.memberships[host.playerId]!.messageWindow,
      );
    },
  );

  test('counts authentication and every authenticated frame, then closes the 21st without applying it', async () => {
    const base = 10_000;
    vi.spyOn(Date, 'now').mockReturnValue(base);
    const host = await createRoom('Host');
    const socket = await connectRoomSocket(host);
    for (let message = 2; message <= MEMBERSHIP_MESSAGE_RATE_LIMIT.messages; message += 1) {
      const error = waitForMessage(socket);
      socket.send('{}');
      await expect(error).resolves.toEqual(
        expect.objectContaining({ type: 'room/error', code: 'invalid-request' }),
      );
    }

    const rejected = waitForMessage(socket);
    const closed = waitForClose(socket);
    socket.send(JSON.stringify({ type: 'game/start' }));
    await expect(rejected).resolves.toEqual({
      type: 'room/error',
      code: 'rate-limited',
      message: 'This Room Membership sent too many messages. Try again shortly.',
    });
    expect((await closed).code).toBe(1008);

    const stub = env.ROOMS.getByName(host.roomCode);
    await expect
      .poll(async () => {
        const stored = await runInDurableObject(stub, async (_instance, state) =>
          state.storage.get(ROOM_STORAGE_KEY),
        );
        return parseRoomSnapshot(stored).room.players[0]?.away;
      })
      .toBe(true);
    const after = parseRoomSnapshot(
      await runInDurableObject(stub, async (_instance, state) =>
        state.storage.get(ROOM_STORAGE_KEY),
      ),
    );
    expect(after.room.phase).toBe('lobby');
    expect(after.memberships[host.playerId]!.messageWindow).toEqual({
      startedAt: base,
      count: MEMBERSHIP_MESSAGE_RATE_LIMIT.messages,
    });
  });

  test('opens a new fixed window exactly at 10,000ms', async () => {
    const base = 20_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(base);
    const host = await createRoom('Host');
    const socket = await connectRoomSocket(host);
    for (let message = 2; message <= MEMBERSHIP_MESSAGE_RATE_LIMIT.messages; message += 1) {
      const error = waitForMessage(socket);
      socket.send('{}');
      await error;
    }

    clock.mockReturnValue(base + MEMBERSHIP_MESSAGE_RATE_LIMIT.windowMs);
    const accepted = waitForMessage(socket);
    socket.send('{}');
    await expect(accepted).resolves.toEqual(
      expect.objectContaining({ type: 'room/error', code: 'invalid-request' }),
    );
    const snapshot = parseRoomSnapshot(
      await runInDurableObject(env.ROOMS.getByName(host.roomCode), async (_instance, state) =>
        state.storage.get(ROOM_STORAGE_KEY),
      ),
    );
    expect(snapshot.memberships[host.playerId]!.messageWindow).toEqual({
      startedAt: base + MEMBERSHIP_MESSAGE_RATE_LIMIT.windowMs,
      count: 1,
    });
    socket.close(1000, 'Test complete.');
  });

  test('persists the Membership quota across connection replacement', async () => {
    const base = 30_000;
    vi.spyOn(Date, 'now').mockReturnValue(base);
    const host = await createRoom('Host');
    const first = await connectRoomSocket(host);
    for (let message = 2; message < MEMBERSHIP_MESSAGE_RATE_LIMIT.messages; message += 1) {
      const error = waitForMessage(first);
      first.send('{}');
      await error;
    }

    const replacement = await openRoomSocket(host.roomCode);
    const oldError = waitForMessage(first);
    const replacementSync = waitForMessage(replacement);
    replacement.send(connectFrame(host));
    await Promise.all([oldError, replacementSync]);
    const rejected = waitForMessage(replacement);
    const closed = waitForClose(replacement);
    replacement.send('{}');
    await expect(rejected).resolves.toEqual(
      expect.objectContaining({ type: 'room/error', code: 'rate-limited' }),
    );
    expect((await closed).code).toBe(1008);
    const snapshot = parseRoomSnapshot(
      await runInDurableObject(env.ROOMS.getByName(host.roomCode), async (_instance, state) =>
        state.storage.get(ROOM_STORAGE_KEY),
      ),
    );
    expect(snapshot.memberships[host.playerId]!.messageWindow.count).toBe(
      MEMBERSHIP_MESSAGE_RATE_LIMIT.messages,
    );
  });

  test('persists the Membership quota across Durable Object eviction', async () => {
    const base = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(base);
    const host = await createRoom('Host');
    const first = await connectRoomSocket(host);
    for (let message = 2; message <= MEMBERSHIP_MESSAGE_RATE_LIMIT.messages; message += 1) {
      const error = waitForMessage(first);
      first.send('{}');
      await error;
    }
    const stub = env.ROOMS.getByName(host.roomCode);
    clock.mockRestore();
    await evictDurableObject(stub);

    const rejected = waitForMessage(first);
    const closed = waitForClose(first);
    first.send('{}');
    await expect(rejected).resolves.toEqual(
      expect.objectContaining({ type: 'room/error', code: 'rate-limited' }),
    );
    expect((await closed).code).toBe(1008);
    const snapshot = parseRoomSnapshot(
      await runInDurableObject(stub, async (_instance, state) =>
        state.storage.get(ROOM_STORAGE_KEY),
      ),
    );
    expect(snapshot.memberships[host.playerId]!.messageWindow.count).toBe(
      MEMBERSHIP_MESSAGE_RATE_LIMIT.messages,
    );
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
    await expect
      .poll(async () => {
        const stored = await runInDurableObject(
          env.ROOMS.getByName(host.roomCode),
          async (_instance, state) => state.storage.get(ROOM_STORAGE_KEY),
        );
        const snapshot = parseRoomSnapshot(stored);
        return {
          away: snapshot.room.players[0]?.away,
          active: snapshot.memberships[host.playerId]?.activeConnectionId,
          grace: snapshot.deadlines.filter((deadline) => deadline.kind === 'membership-grace')
            .length,
        };
      })
      .toEqual({ away: false, active: expect.any(String), grace: 0 });
    replacement.close(1000, 'Test complete.');
  });

  test('every queued mutation from a displaced Connection is transactionally rejected', async () => {
    const host = await createRoom('Host');
    const first = await connectRoomSocket(host);
    const guest = await joinRoom(host.roomCode, 'Guest');
    const hostJoined = waitForMessage(first);
    const guestSocket = await connectRoomSocket(guest);
    await hostJoined;
    const stub = env.ROOMS.getByName(host.roomCode);
    const beforeReplacement = parseRoomSnapshot(
      await runInDurableObject(stub, async (_instance, state) =>
        state.storage.get(ROOM_STORAGE_KEY),
      ),
    );
    const staleConnectionId = beforeReplacement.memberships[host.playerId]!.activeConnectionId!;

    const replacement = await openRoomSocket(host.roomCode);
    const oldError = waitForMessage(first);
    const replacementSync = waitForMessage(replacement);
    replacement.send(connectFrame(host));
    await Promise.all([oldError, replacementSync]);
    const baseline = parseRoomSnapshot(
      await runInDurableObject(stub, async (_instance, state) =>
        state.storage.get(ROOM_STORAGE_KEY),
      ),
    );

    const queuedSocket = await openRoomSocket(host.roomCode);
    await runInDurableObject(stub, async (_instance, state) => {
      const pending = state
        .getWebSockets()
        .find(
          (socket) =>
            (socket.deserializeAttachment() as { state?: string } | null)?.state === 'pending',
        );
      if (!pending) throw new Error('Expected queued stale socket.');
      pending.serializeAttachment({
        state: 'authenticated',
        playerId: host.playerId,
        connectionId: staleConnectionId,
      });
    });
    const staleActions = [
      { type: 'game/start' },
      { type: 'race/hop', article: 'Stale' },
      { type: 'race/giveUp' },
      { type: 'game/playAgain' },
      { type: 'room/kick', playerId: guest.playerId },
    ];
    for (const action of staleActions) {
      const error = waitForMessage(queuedSocket);
      queuedSocket.send(JSON.stringify(action));
      await expect(error).resolves.toEqual(
        expect.objectContaining({ type: 'room/error', code: 'connection-replaced' }),
      );
    }
    expect(
      parseRoomSnapshot(
        await runInDurableObject(stub, async (_instance, state) =>
          state.storage.get(ROOM_STORAGE_KEY),
        ),
      ),
    ).toEqual(baseline);
    queuedSocket.close(1000, 'Test complete.');
    replacement.close(1000, 'Test complete.');
    guestSocket.close(1000, 'Test complete.');
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

  test('a reconnect inside grace keeps identity and cancels eviction', async () => {
    const host = await createRoom('Host');
    const first = await connectRoomSocket(host);
    first.close(1000, 'Temporary disconnect.');
    const stub = env.ROOMS.getByName(host.roomCode);
    await expect
      .poll(async () => {
        const stored = await runInDurableObject(stub, async (_instance, state) =>
          state.storage.get(ROOM_STORAGE_KEY),
        );
        return parseRoomSnapshot(stored).room.players[0]?.away;
      })
      .toBe(true);
    const away = parseRoomSnapshot(
      await runInDurableObject(stub, async (_instance, state) =>
        state.storage.get(ROOM_STORAGE_KEY),
      ),
    );
    expect(away.deadlines).toEqual([
      expect.objectContaining({ kind: 'membership-grace', playerId: host.playerId }),
    ]);

    const replacement = await connectRoomSocket(host);
    const restored = parseRoomSnapshot(
      await runInDurableObject(stub, async (_instance, state) =>
        state.storage.get(ROOM_STORAGE_KEY),
      ),
    );
    expect(restored.room.players).toEqual([
      expect.objectContaining({ id: host.playerId, away: false, isHost: true }),
    ]);
    expect(restored.deadlines).toEqual([]);
    replacement.close(1000, 'Test complete.');
  });

  test('stale and duplicate grace work are idempotent no-ops', async () => {
    const base = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(base);
    const host = await createRoom('Host');
    const hostSocket = await connectRoomSocket(host);
    const guest = await joinRoom(host.roomCode, 'Guest');
    const hostJoined = waitForMessage(hostSocket);
    const guestSocket = await connectRoomSocket(guest);
    await hostJoined;
    const stub = env.ROOMS.getByName(host.roomCode);

    clock.mockReturnValue(base + 1_000);
    guestSocket.close(1000, 'Temporary disconnect.');
    await expect
      .poll(async () => {
        const stored = await runInDurableObject(stub, async (_instance, state) =>
          state.storage.get(ROOM_STORAGE_KEY),
        );
        return parseRoomSnapshot(stored).room.players.find((player) => player.id === guest.playerId)
          ?.away;
      })
      .toBe(true);
    const firstAway = parseRoomSnapshot(
      await runInDurableObject(stub, async (_instance, state) =>
        state.storage.get(ROOM_STORAGE_KEY),
      ),
    );
    const staleGrace = firstAway.deadlines.find(
      (deadline): deadline is MembershipGraceDeadline =>
        deadline.kind === 'membership-grace' && deadline.playerId === guest.playerId,
    )!;
    clock.mockReturnValue(staleGrace.at - 1);
    const replacement = await connectRoomSocket(guest);
    const reconnected = parseRoomSnapshot(
      await runInDurableObject(stub, async (_instance, state) =>
        state.storage.get(ROOM_STORAGE_KEY),
      ),
    );
    expect(
      await runInDurableObject(stub, async (_instance, state) =>
        expireMembershipGrace(state, staleGrace),
      ),
    ).toEqual({ kind: 'none' });
    expect(
      parseRoomSnapshot(
        await runInDurableObject(stub, async (_instance, state) =>
          state.storage.get(ROOM_STORAGE_KEY),
        ),
      ),
    ).toEqual(reconnected);

    clock.mockReturnValue(staleGrace.at + 1_000);
    replacement.close(1000, 'Disconnect again.');
    await expect
      .poll(async () => {
        const stored = await runInDurableObject(stub, async (_instance, state) =>
          state.storage.get(ROOM_STORAGE_KEY),
        );
        return parseRoomSnapshot(stored).deadlines.some(
          (deadline) =>
            deadline.kind === 'membership-grace' &&
            deadline.playerId === guest.playerId &&
            deadline.at > staleGrace.at,
        );
      })
      .toBe(true);
    const secondAway = parseRoomSnapshot(
      await runInDurableObject(stub, async (_instance, state) =>
        state.storage.get(ROOM_STORAGE_KEY),
      ),
    );
    const due = secondAway.deadlines.find(
      (deadline): deadline is MembershipGraceDeadline =>
        deadline.kind === 'membership-grace' && deadline.playerId === guest.playerId,
    )!;
    clock.mockReturnValue(due.at);
    expect(
      await runInDurableObject(stub, async (_instance, state) => expireMembershipGrace(state, due)),
    ).toEqual(expect.objectContaining({ kind: 'sync' }));
    const expired = parseRoomSnapshot(
      await runInDurableObject(stub, async (_instance, state) =>
        state.storage.get(ROOM_STORAGE_KEY),
      ),
    );
    expect(
      await runInDurableObject(stub, async (_instance, state) => expireMembershipGrace(state, due)),
    ).toEqual({ kind: 'none' });
    expect(
      parseRoomSnapshot(
        await runInDurableObject(stub, async (_instance, state) =>
          state.storage.get(ROOM_STORAGE_KEY),
        ),
      ),
    ).toEqual(expired);
    hostSocket.close(1000, 'Test complete.');
  });

  test('hibernated WebSocket error and repeated close callbacks disconnect only once', async () => {
    const host = await createRoom('Host');
    const socket = await connectRoomSocket(host);
    const stub = env.ROOMS.getByName(host.roomCode);
    await evictDurableObject(stub);

    const observed = await runInDurableObject(stub, async (instance, state) => {
      const server = state.getWebSockets()[0]!;
      await instance.webSocketError(server);
      const once = parseRoomSnapshot(await state.storage.get(ROOM_STORAGE_KEY));
      await instance.webSocketClose(server);
      await instance.webSocketClose(server);
      const repeated = parseRoomSnapshot(await state.storage.get(ROOM_STORAGE_KEY));
      return { once, repeated };
    });
    expect(observed.once.deadlines).toEqual([
      expect.objectContaining({ kind: 'membership-grace', playerId: host.playerId }),
    ]);
    expect(observed.repeated).toEqual(observed.once);
    socket.close(1000, 'Test complete.');
  });

  test.each([
    ['one millisecond before', -1, true],
    ['exactly at', 0, false],
    ['one millisecond after', 1, false],
  ])(
    'disconnected Player authentication %s the grace cutoff is accepted=%s',
    async (_label, offset, accepted) => {
      const base = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(base);
      const host = await createRoom('Host');
      clock.mockReturnValue(base + 1);
      const first = await connectRoomSocket(host);
      clock.mockReturnValue(base + 1_000);
      first.close(1000, 'Temporary disconnect.');
      const stub = env.ROOMS.getByName(host.roomCode);
      await expect
        .poll(async () => {
          const stored = await runInDurableObject(stub, async (_instance, state) =>
            state.storage.get(ROOM_STORAGE_KEY),
          );
          return parseRoomSnapshot(stored).room.players[0]?.away;
        })
        .toBe(true);
      const before = parseRoomSnapshot(
        await runInDurableObject(stub, async (_instance, state) =>
          state.storage.get(ROOM_STORAGE_KEY),
        ),
      );
      const grace = before.deadlines.find(
        (deadline) => deadline.kind === 'membership-grace' && deadline.playerId === host.playerId,
      )!;
      if (!accepted) {
        await runInDurableObject(stub, async (_instance, state) =>
          state.storage.setAlarm(grace.at + MEMBERSHIP_GRACE_MS),
        );
      }
      clock.mockReturnValue(grace.at + offset);

      if (accepted) {
        const replacement = await connectRoomSocket(host);
        const restored = parseRoomSnapshot(
          await runInDurableObject(stub, async (_instance, state) =>
            state.storage.get(ROOM_STORAGE_KEY),
          ),
        );
        expect(restored.room.players[0]).toEqual(
          expect.objectContaining({ id: host.playerId, away: false }),
        );
        expect(restored.deadlines).toEqual([]);
        replacement.close(1000, 'Test complete.');
        return;
      }

      const rejectedSocket = await openRoomSocket(host.roomCode);
      const error = waitForMessage(rejectedSocket);
      rejectedSocket.send(connectFrame(host));
      await expect(error).resolves.toEqual(
        expect.objectContaining({ type: 'room/error', code: 'invalid-membership' }),
      );
      const rejected = parseRoomSnapshot(
        await runInDurableObject(stub, async (_instance, state) =>
          state.storage.get(ROOM_STORAGE_KEY),
        ),
      );
      expect(rejected).toEqual(before);

      await runInDurableObject(stub, async (instance) => instance.alarm());
      expect(
        await runInDurableObject(stub, async (_instance, state) =>
          state.storage.get(ROOM_STORAGE_KEY),
        ),
      ).toBeUndefined();
    },
  );

  test('grace expiry removes an away host and transfers authority', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const host = await createRoom('Host');
    const hostSocket = await connectRoomSocket(host);
    const guest = await joinRoom(host.roomCode, 'Guest');
    const hostJoined = waitForMessage(hostSocket);
    const guestSocket = await connectRoomSocket(guest);
    await hostJoined;

    const guestSawAway = waitForMessage(guestSocket);
    hostSocket.close(1000, 'Host disconnected.');
    await expect(guestSawAway).resolves.toEqual(
      expect.objectContaining({
        type: 'room/sync',
        room: expect.objectContaining({
          players: expect.arrayContaining([
            expect.objectContaining({ id: host.playerId, away: true }),
          ]),
        }),
      }),
    );
    const stub = env.ROOMS.getByName(host.roomCode);
    const away = parseRoomSnapshot(
      await runInDurableObject(stub, async (_instance, state) =>
        state.storage.get(ROOM_STORAGE_KEY),
      ),
    );
    const grace = away.deadlines.find(
      (deadline) => deadline.kind === 'membership-grace' && deadline.playerId === host.playerId,
    );
    expect(grace).toBeDefined();

    clock.mockReturnValue(grace!.at);
    const transferred = waitForMessage(guestSocket);
    await runInDurableObject(stub, async (instance) => instance.alarm());
    await expect(transferred).resolves.toEqual(
      expect.objectContaining({
        type: 'room/sync',
        room: expect.objectContaining({
          players: [expect.objectContaining({ id: guest.playerId, isHost: true, away: false })],
        }),
      }),
    );
    const persisted = parseRoomSnapshot(
      await runInDurableObject(stub, async (_instance, state) =>
        state.storage.get(ROOM_STORAGE_KEY),
      ),
    );
    expect(persisted.memberships[host.playerId]).toBeUndefined();
    expect(persisted.memberships[guest.playerId]).toBeDefined();
    guestSocket.close(1000, 'Test complete.');
  });

  test('the transferred host can kick another Membership', async () => {
    const base = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(base);
    const host = await createRoom('Host');
    const hostSocket = await connectRoomSocket(host);
    const successor = await joinRoom(host.roomCode, 'Successor');
    const hostSawSuccessor = waitForMessage(hostSocket);
    const successorSocket = await connectRoomSocket(successor);
    await hostSawSuccessor;
    const target = await joinRoom(host.roomCode, 'Target', SECOND_JOIN_ATTEMPT_ID);
    const hostSawTarget = waitForMessage(hostSocket);
    const successorSawTarget = waitForMessage(successorSocket);
    const targetSocket = await connectRoomSocket(target);
    await Promise.all([hostSawTarget, successorSawTarget]);

    clock.mockReturnValue(base + 1_000);
    const successorSawAway = waitForMessage(successorSocket);
    const targetSawAway = waitForMessage(targetSocket);
    hostSocket.close(1000, 'Host disconnected.');
    await Promise.all([successorSawAway, targetSawAway]);
    const stub = env.ROOMS.getByName(host.roomCode);
    const away = parseRoomSnapshot(
      await runInDurableObject(stub, async (_instance, state) =>
        state.storage.get(ROOM_STORAGE_KEY),
      ),
    );
    const grace = away.deadlines.find(
      (deadline) => deadline.kind === 'membership-grace' && deadline.playerId === host.playerId,
    )!;
    clock.mockReturnValue(grace.at);
    const successorTransferred = waitForMessage(successorSocket);
    const targetTransferred = waitForMessage(targetSocket);
    await runInDurableObject(stub, async (instance) => instance.alarm());
    await Promise.all([successorTransferred, targetTransferred]);

    const kicked = waitForMessage(targetSocket);
    const successorSync = waitForMessage(successorSocket);
    successorSocket.send(JSON.stringify({ type: 'room/kick', playerId: target.playerId }));
    await expect(kicked).resolves.toEqual(
      expect.objectContaining({ type: 'room/error', code: 'kicked' }),
    );
    await expect(successorSync).resolves.toEqual(
      expect.objectContaining({
        type: 'room/sync',
        room: expect.objectContaining({
          players: [expect.objectContaining({ id: successor.playerId, isHost: true })],
        }),
      }),
    );
    successorSocket.close(1000, 'Test complete.');
  });

  test('the host can kick an active Membership atomically', async () => {
    const host = await createRoom('Host');
    const hostSocket = await connectRoomSocket(host);
    const guest = await joinRoom(host.roomCode, 'Guest');
    const hostJoined = waitForMessage(hostSocket);
    const guestSocket = await connectRoomSocket(guest);
    await hostJoined;

    const guestError = waitForMessage(guestSocket);
    const guestClose = waitForClose(guestSocket);
    const hostSync = waitForMessage(hostSocket);
    hostSocket.send(JSON.stringify({ type: 'room/kick', playerId: guest.playerId }));
    await expect(guestError).resolves.toEqual({
      type: 'room/error',
      code: 'kicked',
      message: 'The host removed you from the Room.',
    });
    expect((await guestClose).code).toBe(4003);
    await expect(hostSync).resolves.toEqual(
      expect.objectContaining({
        type: 'room/sync',
        room: expect.objectContaining({
          players: [expect.objectContaining({ id: host.playerId })],
        }),
      }),
    );
    const snapshot = parseRoomSnapshot(
      await runInDurableObject(env.ROOMS.getByName(host.roomCode), async (_instance, state) =>
        state.storage.get(ROOM_STORAGE_KEY),
      ),
    );
    expect(snapshot.memberships[guest.playerId]).toBeUndefined();
    expect(
      Object.values(snapshot.joinAttempts).some((attempt) => attempt.playerId === guest.playerId),
    ).toBe(false);
    expect(snapshot.deadlines).toEqual([]);

    const stale = await openRoomSocket(host.roomCode);
    const staleError = waitForMessage(stale);
    stale.send(connectFrame(guest));
    await expect(staleError).resolves.toEqual(
      expect.objectContaining({ type: 'room/error', code: 'invalid-membership' }),
    );
    hostSocket.close(1000, 'Test complete.');
  });

  test('a non-host kick is rejected without mutating Room state', async () => {
    const host = await createRoom('Host');
    const hostSocket = await connectRoomSocket(host);
    const guest = await joinRoom(host.roomCode, 'Guest');
    const hostJoined = waitForMessage(hostSocket);
    const guestSocket = await connectRoomSocket(guest);
    await hostJoined;
    const stub = env.ROOMS.getByName(host.roomCode);
    const before = parseRoomSnapshot(
      await runInDurableObject(stub, async (_instance, state) =>
        state.storage.get(ROOM_STORAGE_KEY),
      ),
    );

    const error = waitForMessage(guestSocket);
    guestSocket.send(JSON.stringify({ type: 'room/kick', playerId: host.playerId }));
    await expect(error).resolves.toEqual(
      expect.objectContaining({ type: 'room/error', code: 'not-host' }),
    );
    const after = parseRoomSnapshot(
      await runInDurableObject(stub, async (_instance, state) =>
        state.storage.get(ROOM_STORAGE_KEY),
      ),
    );
    expect(after.room).toEqual(before.room);
    expect(after.deadlines).toEqual(before.deadlines);
    expect(after.joinAttempts).toEqual(before.joinAttempts);
    expect(after.memberships[guest.playerId]!.messageWindow.count).toBe(
      before.memberships[guest.playerId]!.messageWindow.count + 1,
    );
    guestSocket.close(1000, 'Test complete.');
    hostSocket.close(1000, 'Test complete.');
  });

  test('the host can kick an away Membership and cancel its grace deadline', async () => {
    const host = await createRoom('Host');
    const hostSocket = await connectRoomSocket(host);
    const guest = await joinRoom(host.roomCode, 'Guest');
    const hostJoined = waitForMessage(hostSocket);
    const guestSocket = await connectRoomSocket(guest);
    await hostJoined;

    const guestAway = waitForMessage(hostSocket);
    guestSocket.close(1000, 'Guest disconnected.');
    await guestAway;
    const hostSync = waitForMessage(hostSocket);
    hostSocket.send(JSON.stringify({ type: 'room/kick', playerId: guest.playerId }));
    await hostSync;
    const persisted = await runInDurableObject(
      env.ROOMS.getByName(host.roomCode),
      async (_instance, state) => ({
        snapshot: parseRoomSnapshot(await state.storage.get(ROOM_STORAGE_KEY)),
        alarm: await state.storage.getAlarm(),
      }),
    );
    expect(persisted.snapshot.room.players.map((player) => player.id)).toEqual([host.playerId]);
    expect(persisted.snapshot.memberships[guest.playerId]).toBeUndefined();
    expect(persisted.snapshot.deadlines).toEqual([]);
    expect(persisted.alarm).toBeNull();
    hostSocket.close(1000, 'Test complete.');
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

async function joinRoom(
  roomCode: string,
  playerName: string,
  attemptId = JOIN_ATTEMPT_ID,
): Promise<JoinRoomResponse> {
  const response = await SELF.fetch(`https://example.test/api/rooms/${roomCode}/memberships`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerName, attemptId, generation: 0 }),
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
