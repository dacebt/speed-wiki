import type {
  CreateRoomResponse,
  JoinRoomResponse,
  RoomPhase,
  ServerMessage,
} from '@wikispeedrun/shared';
import { env } from 'cloudflare:workers';
import { reset, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { phaseDeadline } from './roomSchedule.js';
import { ROOM_STORAGE_KEY, parseRoomSnapshot } from './snapshot.js';

const ATTEMPT_ID = '9e2a5f17-b57f-4ee9-9a7d-b4ae8f2dd1b2';

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe('Worker lobby actions', () => {
  test('persists and broadcasts lobby actions while retaining core authorization', async () => {
    const room = await createLobbyRoom();

    const hostSettings = waitForPhase(room.hostSocket, 'lobby');
    const guestSettings = waitForPhase(room.guestSocket, 'lobby');
    room.hostSocket.send(
      JSON.stringify({
        type: 'room/setSettings',
        settings: { roundDurationMs: 180_000, countdownMs: 5_000, category: 'history' },
      }),
    );
    const settingsViews = await Promise.all([hostSettings, guestSettings]);
    expect(settingsViews[0]).toEqual(settingsViews[1]);
    expect(settingsViews[0].settings).toEqual({
      roundDurationMs: 180_000,
      countdownMs: 5_000,
      difficulty: 'curated',
      category: 'history',
    });
    const configured = await storedRuntime(room.code);
    expect(configured.snapshot.room.settings).toEqual(settingsViews[0].settings);

    const guestSettingsError = waitForMessage(room.guestSocket);
    room.guestSocket.send(
      JSON.stringify({ type: 'room/setSettings', settings: { difficulty: 'random' } }),
    );
    expect(await guestSettingsError).toEqual(
      expect.objectContaining({ type: 'room/error', code: 'not-host' }),
    );
    const rejectedGuestSettings = await storedRuntime(room.code);
    expect(rejectedGuestSettings.snapshot.room.settings).toEqual(configured.snapshot.room.settings);

    const rangeError = waitForMessage(room.hostSocket);
    room.hostSocket.send(
      JSON.stringify({ type: 'room/setSettings', settings: { roundDurationMs: 1 } }),
    );
    expect(await rangeError).toEqual(
      expect.objectContaining({ type: 'room/error', code: 'invalid-settings' }),
    );
    const rejectedRange = await storedRuntime(room.code);
    expect(rejectedRange.snapshot.room.settings).toEqual(configured.snapshot.room.settings);

    const fractionalDurationError = waitForMessage(room.hostSocket);
    room.hostSocket.send(
      JSON.stringify({
        type: 'room/setSettings',
        settings: { roundDurationMs: 60_000.5 },
      }),
    );
    expect(await fractionalDurationError).toEqual(
      expect.objectContaining({ type: 'room/error', code: 'invalid-settings' }),
    );
    const rejectedFractionalDuration = await storedRuntime(room.code);
    expect(rejectedFractionalDuration.snapshot.room.settings).toEqual(
      configured.snapshot.room.settings,
    );

    const catalogError = waitForMessage(room.hostSocket);
    room.hostSocket.send(
      JSON.stringify({
        type: 'room/setSettings',
        settings: { difficulty: 'impossible', category: 'literature' },
      }),
    );
    expect(await catalogError).toEqual(
      expect.objectContaining({ type: 'room/error', code: 'invalid-settings' }),
    );
    const rejectedCatalog = await storedRuntime(room.code);
    expect(rejectedCatalog.snapshot.room.settings).toEqual(configured.snapshot.room.settings);

    const hostCosmetics = waitForPhase(room.hostSocket, 'lobby');
    const guestCosmetics = waitForPhase(room.guestSocket, 'lobby');
    room.guestSocket.send(
      JSON.stringify({
        type: 'player/setCosmetics',
        cosmetics: { faceId: 'owl', hatId: 'crown' },
      }),
    );
    const cosmeticsViews = await Promise.all([hostCosmetics, guestCosmetics]);
    expect(cosmeticsViews[0]).toEqual(cosmeticsViews[1]);
    expect(
      cosmeticsViews[0].players.find((player) => player.id === room.guest.playerId)?.cosmetics,
    ).toEqual({ faceId: 'owl', hatId: 'crown' });
    const customized = await storedRuntime(room.code);
    expect(
      customized.snapshot.room.players.find((player) => player.id === room.guest.playerId)
        ?.cosmetics,
    ).toEqual({ faceId: 'owl', hatId: 'crown' });

    const invalidCosmeticsError = waitForMessage(room.guestSocket);
    room.guestSocket.send(
      JSON.stringify({
        type: 'player/setCosmetics',
        cosmetics: { faceId: 'unknown-face', hatId: 'unknown-hat' },
      }),
    );
    expect(await invalidCosmeticsError).toEqual(
      expect.objectContaining({ type: 'room/error', code: 'invalid-cosmetics' }),
    );
    const rejectedCosmetics = await storedRuntime(room.code);
    expect(
      rejectedCosmetics.snapshot.room.players.find((player) => player.id === room.guest.playerId)
        ?.cosmetics,
    ).toEqual({ faceId: 'owl', hatId: 'crown' });

    closeRoom(room);
  });

  test('cosmetics during preparation preserve pending work and its alarm', async () => {
    const room = await createLobbyRoom();
    const hostPreparing = waitForPhase(room.hostSocket, 'preparing');
    const guestPreparing = waitForPhase(room.guestSocket, 'preparing');
    room.hostSocket.send(JSON.stringify({ type: 'game/start' }));
    await Promise.all([hostPreparing, guestPreparing]);
    const preparation = await storedRuntime(room.code);
    expect(preparation.snapshot.roundPreparation).not.toBeNull();
    expect(phaseDeadline(preparation.snapshot.deadlines)?.kind).toBe('round-preparation');
    expect(preparation.alarm).not.toBeNull();

    const hostCustomized = waitForPhase(room.hostSocket, 'preparing');
    const guestCustomized = waitForPhase(room.guestSocket, 'preparing');
    room.guestSocket.send(
      JSON.stringify({
        type: 'player/setCosmetics',
        cosmetics: { faceId: 'robot', hatId: 'party' },
      }),
    );
    await Promise.all([hostCustomized, guestCustomized]);
    const customized = await storedRuntime(room.code);
    expect(customized.snapshot.roundPreparation).toEqual(preparation.snapshot.roundPreparation);
    expect(customized.snapshot.deadlines).toEqual(preparation.snapshot.deadlines);
    expect(customized.alarm).toBe(preparation.alarm);

    vi.spyOn(Date, 'now').mockReturnValue(customized.alarm!);
    const hostCountdown = waitForPhase(room.hostSocket, 'countdown');
    const guestCountdown = waitForPhase(room.guestSocket, 'countdown');
    expect(await runDurableObjectAlarm(env.ROOMS.getByName(room.code))).toBe(true);
    await Promise.all([hostCountdown, guestCountdown]);
    const countdown = await storedRuntime(room.code);
    expect(countdown.snapshot.room.phase).toBe('countdown');
    expect(countdown.snapshot.roundPreparation?.pair).not.toBeNull();
    expect(phaseDeadline(countdown.snapshot.deadlines)?.kind).toBe('countdown');

    closeRoom(room);
  });
});

interface LobbyRoom {
  code: string;
  guest: JoinRoomResponse;
  hostSocket: WebSocket;
  guestSocket: WebSocket;
}

async function createLobbyRoom(): Promise<LobbyRoom> {
  const host = await createRoom('Host');
  const hostSocket = await connect(host);
  const guest = await joinRoom(host.roomCode, 'Guest');
  const hostJoined = waitForMessage(hostSocket);
  const guestSocket = await connect(guest);
  await hostJoined;
  return { code: host.roomCode, guest, hostSocket, guestSocket };
}

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

async function waitForPhase(socket: WebSocket, phase: RoomPhase) {
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

function closeRoom(room: LobbyRoom): void {
  room.hostSocket.close(1000, 'Test complete.');
  room.guestSocket.close(1000, 'Test complete.');
}
