import type { CreateRoomResponse, JoinRoomResponse, ServerMessage } from '@wikispeedrun/shared';
import { env } from 'cloudflare:workers';
import {
  evictDurableObject,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
  SELF,
} from 'cloudflare:test';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { startRoundPreparation } from './roomLifecycle.js';
import { ROOM_STORAGE_KEY, parseRoomSnapshot } from './snapshot.js';

const ATTEMPT_ID = '9e2a5f17-b57f-4ee9-9a7d-b4ae8f2dd1b2';

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await reset();
});

describe('durable Round preparation and countdown', () => {
  test('persists preparation and its alarm before broadcasting', async () => {
    const host = await createRoom('Host');
    const socket = await connect(host);
    const next = waitForMessage(socket);
    socket.send(JSON.stringify({ type: 'game/start' }));

    expect(await next).toEqual(
      expect.objectContaining({
        type: 'room/sync',
        room: expect.objectContaining({ phase: 'preparing' }),
      }),
    );
    const persisted = await storedRuntime(host.roomCode);
    expect(persisted.snapshot.room.phase).toBe('preparing');
    expect(persisted.snapshot.roundPreparation).toEqual(
      expect.objectContaining({ pair: null, difficulty: 'curated', category: 'any' }),
    );
    expect(persisted.snapshot.deadline).toEqual(
      expect.objectContaining({
        kind: 'round-preparation',
        token: persisted.snapshot.roundPreparation?.token,
      }),
    );
    expect(persisted.alarm).toBe(persisted.snapshot.deadline?.at);
    socket.close(1000, 'Test complete.');
  });

  test('eviction preserves one pair through due preparation and countdown alarms', async () => {
    const host = await createRoom('Host');
    const hostSocket = await connect(host);
    const guest = await joinRoom(host.roomCode, 'Guest');
    const hostJoined = waitForMessage(hostSocket);
    const guestSocket = await connect(guest);
    await hostJoined;
    const stub = env.ROOMS.getByName(host.roomCode);

    const hostPreparing = waitForPhase(hostSocket, 'preparing');
    const guestPreparing = waitForPhase(guestSocket, 'preparing');
    hostSocket.send(JSON.stringify({ type: 'game/start' }));
    await Promise.all([hostPreparing, guestPreparing]);

    const preparation = await storedRuntime(host.roomCode);
    const now = vi.spyOn(Date, 'now').mockReturnValue(preparation.snapshot.deadline!.at);
    await evictDurableObject(stub);
    const hostCountdown = waitForPhase(hostSocket, 'countdown');
    const guestCountdown = waitForPhase(guestSocket, 'countdown');
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await Promise.all([hostCountdown, guestCountdown]);
    const countdown = await storedRuntime(host.roomCode);
    expect(countdown.snapshot.roundPreparation?.pair).not.toBeNull();
    expect(countdown.snapshot.deadline).toEqual(
      expect.objectContaining({
        kind: 'countdown',
        at: countdown.snapshot.room.countdownEndsAt,
      }),
    );
    expect(countdown.alarm).toBe(countdown.snapshot.room.countdownEndsAt);

    now.mockReturnValue(countdown.snapshot.deadline!.at);
    await evictDurableObject(stub);
    const hostRacing = waitForPhase(hostSocket, 'racing');
    const guestRacing = waitForPhase(guestSocket, 'racing');
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const racing = await Promise.all([hostRacing, guestRacing]);
    const pairs = racing.map((room) => room.round).filter(Boolean);
    expect(pairs[0]).toEqual(pairs[1]);
    expect(pairs[0]).toEqual(
      expect.objectContaining({
        startArticle: countdown.snapshot.roundPreparation?.pair?.startArticle,
        goalArticle: countdown.snapshot.roundPreparation?.pair?.goalArticle,
      }),
    );
    const started = await storedRuntime(host.roomCode);
    expect(started.snapshot.roundPreparation).toBeNull();
    expect(started.snapshot.deadline).toEqual({
      kind: 'round-timeout',
      token: `round:${started.snapshot.room.round?.roundNumber}:${started.snapshot.room.round?.startedAt}`,
      at: started.snapshot.room.round?.deadline,
    });
    expect(started.alarm).toBe(started.snapshot.room.round?.deadline);
    hostSocket.close(1000, 'Test complete.');
    guestSocket.close(1000, 'Test complete.');
  });

  test('stale alarm delivery before the countdown deadline is a rescheduled no-op', async () => {
    const host = await createRoom('Host');
    const socket = await connect(host);
    const stub = env.ROOMS.getByName(host.roomCode);
    const preparing = waitForPhase(socket, 'preparing');
    socket.send(JSON.stringify({ type: 'game/start' }));
    await preparing;

    const pending = await storedRuntime(host.roomCode);
    const now = vi.spyOn(Date, 'now').mockReturnValue(pending.snapshot.deadline!.at);
    const countdownMessage = waitForPhase(socket, 'countdown');
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await countdownMessage;
    const countdown = await storedRuntime(host.roomCode);

    expect(countdown.snapshot.deadline?.kind).toBe('countdown');
    expect(countdown.snapshot.deadline!.at).toBeGreaterThan(Date.now());
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const rescheduled = await storedRuntime(host.roomCode);
    expect(rescheduled).toEqual(countdown);

    now.mockReturnValue(countdown.snapshot.deadline!.at);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await storedRuntime(host.roomCode)).snapshot.room.phase).toBe('racing');
    socket.close(1000, 'Test complete.');
  });

  test('non-host Start is rejected without durable state or alarm mutation', async () => {
    const host = await createRoom('Host');
    const guest = await joinRoom(host.roomCode, 'Guest');
    const guestSocket = await connect(guest);
    const stub = env.ROOMS.getByName(host.roomCode);
    const before = await storedRuntime(host.roomCode);

    const result = await runInDurableObject(stub, async (_instance, state) =>
      startRoundPreparation(state, guest.playerId),
    );

    expect(result).toEqual({
      kind: 'error',
      code: 'not-host',
      message: 'Only the host may start the race.',
    });
    expect(await storedRuntime(host.roomCode)).toEqual(before);
    guestSocket.close(1000, 'Test complete.');
  });

  test('random selection exhaustion returns everyone to the lobby honestly', async () => {
    const host = await createRoom('Host');
    const socket = await connect(host);
    const stub = env.ROOMS.getByName(host.roomCode);
    await runInDurableObject(stub, async (_instance, state) => {
      const snapshot = parseRoomSnapshot(await state.storage.get(ROOM_STORAGE_KEY));
      snapshot.room.settings.difficulty = 'random';
      await state.storage.put(ROOM_STORAGE_KEY, snapshot);
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const preparing = waitForMessage(socket);
    socket.send(JSON.stringify({ type: 'game/start' }));
    expect(syncRoom(await preparing).phase).toBe('preparing');
    const pending = await storedRuntime(host.roomCode);
    vi.spyOn(Date, 'now').mockReturnValue(pending.snapshot.deadline!.at);
    const failureMessages = waitForMessages(socket, 2);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const [error, lobby] = await failureMessages;
    expect(error).toEqual(
      expect.objectContaining({ type: 'room/error', code: 'article-fetch-failed' }),
    );
    expect(syncRoom(lobby!)).toEqual(expect.objectContaining({ phase: 'lobby' }));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const persisted = await storedRuntime(host.roomCode);
    expect(persisted.snapshot.roundPreparation).toBeNull();
    expect(persisted.snapshot.deadline).toBeNull();
    expect(persisted.alarm).toBeNull();
    socket.close(1000, 'Test complete.');
  });

  test('a stale selection result cannot replace newer durable state', async () => {
    const host = await createRoom('Host');
    const socket = await connect(host);
    const stub = env.ROOMS.getByName(host.roomCode);
    await runInDurableObject(stub, async (_instance, state) => {
      const snapshot = parseRoomSnapshot(await state.storage.get(ROOM_STORAGE_KEY));
      snapshot.room.settings.difficulty = 'random';
      await state.storage.put(ROOM_STORAGE_KEY, snapshot);
    });
    let releaseFetch!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      releaseFetch = resolve;
    });
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(response));

    const preparing = waitForMessage(socket);
    socket.send(JSON.stringify({ type: 'game/start' }));
    await preparing;
    const pending = await storedRuntime(host.roomCode);
    vi.spyOn(Date, 'now').mockReturnValue(pending.snapshot.deadline!.at);
    await runInDurableObject(stub, async (instance, state) => {
      const inFlight = instance.alarm();
      await Promise.resolve();
      const snapshot = parseRoomSnapshot(await state.storage.get(ROOM_STORAGE_KEY));
      snapshot.room.phase = 'lobby';
      snapshot.roundPreparation = null;
      snapshot.deadline = null;
      await state.storage.put(ROOM_STORAGE_KEY, snapshot);
      await state.storage.deleteAlarm();
      releaseFetch(
        Response.json({
          query: {
            random: [{ title: 'Ada Lovelace' }, { title: 'Analytical Engine' }],
          },
        }),
      );
      await inFlight;
    });

    const persisted = await storedRuntime(host.roomCode);
    expect(persisted.snapshot.room.phase).toBe('lobby');
    expect(persisted.snapshot.roundPreparation).toBeNull();
    expect(persisted.snapshot.deadline).toBeNull();
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

async function joinRoom(roomCode: string, playerName: string): Promise<JoinRoomResponse> {
  const response = await SELF.fetch(`https://example.test/api/rooms/${roomCode}/memberships`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerName, attemptId: ATTEMPT_ID, generation: 0 }),
  });
  expect(response.status).toBe(201);
  return response.json<JoinRoomResponse>();
}

async function connect(membership: CreateRoomResponse): Promise<WebSocket> {
  const response = await SELF.fetch(
    `https://example.test/api/rooms/${membership.roomCode}/websocket`,
    { headers: { Upgrade: 'websocket' } },
  );
  const socket = response.webSocket;
  if (!socket) throw new Error('Missing WebSocket.');
  socket.accept();
  socket.send(
    JSON.stringify({
      type: 'room/connect',
      playerId: membership.playerId,
      rejoinCredential: membership.rejoinCredential,
    }),
  );
  await waitForMessage(socket);
  return socket;
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

function waitForMessages(socket: WebSocket, count: number): Promise<ServerMessage[]> {
  return new Promise((resolve, reject) => {
    const messages: ServerMessage[] = [];
    const receive = (event: MessageEvent) => {
      try {
        messages.push(JSON.parse(String(event.data)) as ServerMessage);
        if (messages.length !== count) return;
        socket.removeEventListener('message', receive);
        resolve(messages);
      } catch (error) {
        socket.removeEventListener('message', receive);
        reject(error);
      }
    };
    socket.addEventListener('message', receive);
  });
}

function syncRoom(message: ServerMessage) {
  if (message.type !== 'room/sync') throw new Error(`Expected sync, received ${message.type}.`);
  return message.room;
}

async function waitForPhase(socket: WebSocket, phase: 'preparing' | 'countdown' | 'racing') {
  for (;;) {
    const message = await waitForMessage(socket);
    if (message.type === 'room/sync' && message.room.phase === phase) return message.room;
  }
}

async function storedRuntime(roomCode: string) {
  return runInDurableObject(env.ROOMS.getByName(roomCode), async (_instance, state) => ({
    snapshot: parseRoomSnapshot(await state.storage.get(ROOM_STORAGE_KEY)),
    alarm: await state.storage.getAlarm(),
  }));
}
