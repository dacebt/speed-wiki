import type {
  CreateRoomResponse,
  JoinRoomResponse,
  RoomPhase,
  ServerMessage,
} from '@wikispeedrun/shared';
import { env } from 'cloudflare:workers';
import {
  evictDurableObject,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
  SELF,
} from 'cloudflare:test';
import { afterEach, describe, expect, test, vi, type MockInstance } from 'vitest';
import { phaseDeadline } from './roomSchedule.js';
import { ROOM_STORAGE_KEY, parseRoomSnapshot } from './snapshot.js';

const ATTEMPT_ID = '9e2a5f17-b57f-4ee9-9a7d-b4ae8f2dd1b2';
const SECOND_ATTEMPT_ID = '2297ac68-da58-4cad-94ae-e5f863beab60';

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe('authoritative Worker gameplay', () => {
  test('persists hops, scores all-done results, and authorizes only host replay', async () => {
    const room = await createRacingRoom();
    const beforeReplay = await storedRuntime(room.code);
    const replayError = waitForMessage(room.hostSocket);
    room.hostSocket.send(JSON.stringify({ type: 'game/playAgain' }));
    expect(await replayError).toEqual(
      expect.objectContaining({ type: 'room/error', code: 'wrong-phase' }),
    );
    expect(await storedRuntime(room.code)).toEqual(beforeReplay);

    room.now.mockReturnValue(room.startedAt + 1_000);
    const ordinaryHop = waitForPhase(room.hostSocket, 'racing');
    const ordinaryHopGuest = waitForPhase(room.guestSocket, 'racing');
    room.hostSocket.send(JSON.stringify({ type: 'race/hop', article: 'Middle Article' }));
    await Promise.all([ordinaryHop, ordinaryHopGuest]);
    const afterHop = await storedRuntime(room.code);
    expect(
      afterHop.snapshot.room.players.find((player) => player.id === room.host.playerId)?.path,
    ).toEqual([room.startArticle, 'Middle Article']);
    expect(afterHop.snapshot.deadlines).toEqual(beforeReplay.snapshot.deadlines);
    expect(afterHop.alarm).toBe(beforeReplay.alarm);

    room.now.mockReturnValue(room.startedAt + 2_000);
    const hostFinished = waitForPhase(room.hostSocket, 'racing');
    const guestSawFinish = waitForPhase(room.guestSocket, 'racing');
    room.hostSocket.send(JSON.stringify({ type: 'race/hop', article: room.goalArticle }));
    await Promise.all([hostFinished, guestSawFinish]);
    const afterFinish = await storedRuntime(room.code);
    const finishedHost = afterFinish.snapshot.room.players.find(
      (player) => player.id === room.host.playerId,
    );
    expect(finishedHost).toEqual(expect.objectContaining({ finishedRank: 1 }));
    expect(finishedHost?.path).toHaveLength(3);
    expect(afterFinish.snapshot.deadlines).toEqual(beforeReplay.snapshot.deadlines);
    expect(afterFinish.alarm).toBe(beforeReplay.alarm);

    room.now.mockReturnValue(room.startedAt + 3_000);
    const hostResults = waitForPhase(room.hostSocket, 'results');
    const guestResults = waitForPhase(room.guestSocket, 'results');
    room.guestSocket.send(JSON.stringify({ type: 'race/giveUp' }));
    const [hostView, guestView] = await Promise.all([hostResults, guestResults]);
    expect(hostView).toEqual(guestView);
    const results = await storedRuntime(room.code);
    const hostResult = results.snapshot.room.players.find(
      (player) => player.id === room.host.playerId,
    );
    const guestResult = results.snapshot.room.players.find(
      (player) => player.id === room.guest.playerId,
    );
    expect(hostResult).toEqual(
      expect.objectContaining({ finishedRank: 1, roundPoints: 5, score: 5 }),
    );
    expect(guestResult).toEqual(
      expect.objectContaining({ gaveUp: true, roundPoints: 0, score: 0 }),
    );
    expect(results.snapshot.deadlines).toEqual([]);
    expect(results.alarm).toBeNull();
    expect(Date.now()).toBeLessThan(room.roundDeadline);

    const guestReplayError = waitForMessage(room.guestSocket);
    room.guestSocket.send(JSON.stringify({ type: 'game/playAgain' }));
    expect(await guestReplayError).toEqual(
      expect.objectContaining({ type: 'room/error', code: 'not-host' }),
    );
    expect(await storedRuntime(room.code)).toEqual(results);

    const hostLobby = waitForPhase(room.hostSocket, 'lobby');
    const guestLobby = waitForPhase(room.guestSocket, 'lobby');
    room.hostSocket.send(JSON.stringify({ type: 'game/playAgain' }));
    await Promise.all([hostLobby, guestLobby]);
    const replayed = await storedRuntime(room.code);
    expect(replayed.snapshot.room).toEqual(
      expect.objectContaining({ phase: 'lobby', round: null, countdownEndsAt: null }),
    );
    expect(replayed.snapshot.deadlines).toEqual([]);
    expect(replayed.alarm).toBeNull();
    closeRoom(room);
  });

  test('recovers a due timeout after eviction and ignores early and duplicate delivery', async () => {
    const room = await createRacingRoom();
    const stub = env.ROOMS.getByName(room.code);
    const racing = await storedRuntime(room.code);

    room.now.mockReturnValue(room.startedAt + 1_000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await storedRuntime(room.code)).toEqual(racing);

    await evictDurableObject(stub);
    room.now.mockReturnValue(room.roundDeadline);
    const hostResults = waitForPhase(room.hostSocket, 'results');
    const guestResults = waitForPhase(room.guestSocket, 'results');
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const views = await Promise.all([hostResults, guestResults]);
    expect(views[0]).toEqual(views[1]);
    const results = await storedRuntime(room.code);
    expect(results.snapshot.room.phase).toBe('results');
    expect(results.snapshot.room.players.every((player) => player.roundPoints === 0)).toBe(true);
    expect(results.snapshot.deadlines).toEqual([]);
    expect(results.alarm).toBeNull();

    expect(await runDurableObjectAlarm(stub)).toBe(false);
    await runInDurableObject(stub, async (instance) => instance.alarm());
    expect(await storedRuntime(room.code)).toEqual(results);
    closeRoom(room);
  });

  test('a goal hop by the final active Player clears the timeout before results sync', async () => {
    const room = await createRacingRoom();
    const racing = await storedRuntime(room.code);

    room.now.mockReturnValue(room.startedAt + 1_000);
    const hostSawGiveUp = waitForPhase(room.hostSocket, 'racing');
    const guestGaveUp = waitForPhase(room.guestSocket, 'racing');
    room.guestSocket.send(JSON.stringify({ type: 'race/giveUp' }));
    await Promise.all([hostSawGiveUp, guestGaveUp]);
    const oneActive = await storedRuntime(room.code);
    expect(oneActive.snapshot.deadlines).toEqual(racing.snapshot.deadlines);
    expect(oneActive.alarm).toBe(racing.alarm);

    room.now.mockReturnValue(room.startedAt + 2_000);
    const hostResults = waitForPhase(room.hostSocket, 'results');
    const guestResults = waitForPhase(room.guestSocket, 'results');
    room.hostSocket.send(JSON.stringify({ type: 'race/hop', article: room.goalArticle }));
    await Promise.all([hostResults, guestResults]);
    const results = await storedRuntime(room.code);
    expect(
      results.snapshot.room.players.find((player) => player.id === room.host.playerId),
    ).toEqual(expect.objectContaining({ finishedRank: 1, roundPoints: 5, score: 5 }));
    expect(results.snapshot.deadlines).toEqual([]);
    expect(results.alarm).toBeNull();
    expect(Date.now()).toBeLessThan(room.roundDeadline);
    closeRoom(room);
  });

  test('an away final racer ends the round when their grace expires', async () => {
    const room = await createRacingRoom();
    const stub = env.ROOMS.getByName(room.code);

    room.now.mockReturnValue(room.startedAt + 1_000);
    const hostFinished = waitForPhase(room.hostSocket, 'racing');
    const guestSawFinish = waitForPhase(room.guestSocket, 'racing');
    room.hostSocket.send(JSON.stringify({ type: 'race/hop', article: room.goalArticle }));
    await Promise.all([hostFinished, guestSawFinish]);

    room.now.mockReturnValue(room.startedAt + 2_000);
    const hostSawAway = waitForPhase(room.hostSocket, 'racing');
    room.guestSocket.close(1000, 'Racer disconnected.');
    await hostSawAway;
    const away = await storedRuntime(room.code);
    const grace = away.snapshot.deadlines.find(
      (deadline) =>
        deadline.kind === 'membership-grace' && deadline.playerId === room.guest.playerId,
    );
    expect(grace).toBeDefined();
    expect(phaseDeadline(away.snapshot.deadlines)?.kind).toBe('round-timeout');

    room.now.mockReturnValue(grace!.at);
    const hostResults = waitForPhase(room.hostSocket, 'results');
    await runInDurableObject(stub, async (instance) => instance.alarm());
    await hostResults;
    const results = await storedRuntime(room.code);
    expect(results.snapshot.room.phase).toBe('results');
    expect(results.snapshot.room.players).toEqual([
      expect.objectContaining({
        id: room.host.playerId,
        finishedRank: 1,
        roundPoints: 5,
        score: 5,
      }),
    ]);
    expect(results.snapshot.memberships[room.guest.playerId]).toBeUndefined();
    expect(results.snapshot.deadlines).toEqual([]);
    expect(results.alarm).toBeNull();
    room.hostSocket.close(1000, 'Test complete.');
  });

  test('a tied grace deadline drains before the round timeout', async () => {
    const room = await createRacingRoom(true);
    const stub = env.ROOMS.getByName(room.code);
    if (!room.secondGuest || !room.secondGuestSocket) throw new Error('Expected third racer.');
    room.now.mockReturnValue(room.roundDeadline - 45_000);
    const hostSawFirstAway = waitForPhase(room.hostSocket, 'racing');
    room.guestSocket.close(1000, 'Guest disconnected.');
    await hostSawFirstAway;
    const hostSawSecondAway = waitForPhase(room.hostSocket, 'racing');
    room.secondGuestSocket.close(1000, 'Second guest disconnected.');
    await hostSawSecondAway;
    const tied = await storedRuntime(room.code);
    expect(tied.snapshot.deadlines).toHaveLength(3);
    expect(new Set(tied.snapshot.deadlines.map((deadline) => deadline.at))).toEqual(
      new Set([room.roundDeadline]),
    );
    const orderedPlayers = [room.guest.playerId, room.secondGuest.playerId].sort();

    room.now.mockReturnValue(room.roundDeadline);
    await runInDurableObject(stub, async (instance) => instance.alarm());
    const afterFirst = await storedRuntime(room.code);
    expect(afterFirst.snapshot.room.players.map((player) => player.id)).not.toContain(
      orderedPlayers[0],
    );
    expect(afterFirst.snapshot.room.players.map((player) => player.id)).toContain(
      orderedPlayers[1],
    );
    expect(afterFirst.alarm).toBe(room.roundDeadline);

    await runInDurableObject(stub, async (instance) => instance.alarm());
    const afterSecond = await storedRuntime(room.code);
    expect(afterSecond.snapshot.room.players.map((player) => player.id)).toEqual([
      room.host.playerId,
    ]);
    expect(afterSecond.snapshot.deadlines).toEqual([
      expect.objectContaining({ kind: 'round-timeout', at: room.roundDeadline }),
    ]);
    expect(afterSecond.alarm).toBe(room.roundDeadline);

    const hostResults = waitForPhase(room.hostSocket, 'results');
    await runInDurableObject(stub, async (instance) => instance.alarm());
    await hostResults;
    const results = await storedRuntime(room.code);
    expect(results.snapshot.room.phase).toBe('results');
    expect(results.snapshot.deadlines).toEqual([]);
    expect(results.alarm).toBeNull();
    room.hostSocket.close(1000, 'Test complete.');
  });
});

interface RacingRoom {
  code: string;
  host: CreateRoomResponse;
  guest: JoinRoomResponse;
  secondGuest?: JoinRoomResponse;
  hostSocket: WebSocket;
  guestSocket: WebSocket;
  secondGuestSocket?: WebSocket;
  now: MockInstance<() => number>;
  startArticle: string;
  goalArticle: string;
  startedAt: number;
  roundDeadline: number;
}

async function createRacingRoom(withSecondGuest = false): Promise<RacingRoom> {
  const host = await createRoom('Host');
  const hostSocket = await connect(host);
  const guest = await joinRoom(host.roomCode, 'Guest');
  const hostJoined = waitForMessage(hostSocket);
  const guestSocket = await connect(guest);
  await hostJoined;
  let secondGuest: JoinRoomResponse | undefined;
  let secondGuestSocket: WebSocket | undefined;
  if (withSecondGuest) {
    secondGuest = await joinRoom(host.roomCode, 'Second Guest', SECOND_ATTEMPT_ID);
    const hostSawSecond = waitForMessage(hostSocket);
    const guestSawSecond = waitForMessage(guestSocket);
    secondGuestSocket = await connect(secondGuest);
    await Promise.all([hostSawSecond, guestSawSecond]);
  }
  const stub = env.ROOMS.getByName(host.roomCode);

  const preparing = [waitForPhase(hostSocket, 'preparing'), waitForPhase(guestSocket, 'preparing')];
  if (secondGuestSocket) preparing.push(waitForPhase(secondGuestSocket, 'preparing'));
  hostSocket.send(JSON.stringify({ type: 'game/start' }));
  await Promise.all(preparing);
  const preparation = await storedRuntime(host.roomCode);
  const now = vi
    .spyOn(Date, 'now')
    .mockReturnValue(phaseDeadline(preparation.snapshot.deadlines)!.at);

  const countdownViews = [
    waitForPhase(hostSocket, 'countdown'),
    waitForPhase(guestSocket, 'countdown'),
  ];
  if (secondGuestSocket) countdownViews.push(waitForPhase(secondGuestSocket, 'countdown'));
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  await Promise.all(countdownViews);
  const countdown = await storedRuntime(host.roomCode);
  now.mockReturnValue(phaseDeadline(countdown.snapshot.deadlines)!.at);

  const racingViews = [waitForPhase(hostSocket, 'racing'), waitForPhase(guestSocket, 'racing')];
  if (secondGuestSocket) racingViews.push(waitForPhase(secondGuestSocket, 'racing'));
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  await Promise.all(racingViews);
  const racing = await storedRuntime(host.roomCode);
  const round = racing.snapshot.room.round;
  if (!round) throw new Error('Expected persisted racing Round.');
  expect(phaseDeadline(racing.snapshot.deadlines)).toEqual({
    kind: 'round-timeout',
    token: `round:${round.roundNumber}:${round.startedAt}`,
    at: round.deadline,
  });
  expect(racing.alarm).toBe(round.deadline);
  return {
    code: host.roomCode,
    host,
    guest,
    hostSocket,
    guestSocket,
    ...(secondGuest && secondGuestSocket ? { secondGuest, secondGuestSocket } : {}),
    now,
    startArticle: round.startArticle,
    goalArticle: round.goalArticle,
    startedAt: round.startedAt,
    roundDeadline: round.deadline,
  };
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

async function joinRoom(
  roomCode: string,
  playerName: string,
  attemptId = ATTEMPT_ID,
): Promise<JoinRoomResponse> {
  const response = await SELF.fetch(`https://example.test/api/rooms/${roomCode}/memberships`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerName, attemptId, generation: 0 }),
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

function closeRoom(room: RacingRoom): void {
  room.hostSocket.close(1000, 'Test complete.');
  room.guestSocket.close(1000, 'Test complete.');
  room.secondGuestSocket?.close(1000, 'Test complete.');
}
