import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoom, joinRoom, subscribe, supportsRaceActions } from './transport.worker.js';
import { CREDENTIAL, PLAYER_ID, workerTransportLobby } from './transport.worker.fixtures.js';

const sockets: MockWebSocket[] = [];

class MockWebSocket extends EventTarget {
  static readonly OPEN = 1;

  readonly sent: string[] = [];
  readonly url: string | URL;
  readyState = 0;

  constructor(url: string | URL) {
    super();
    this.url = url;
    sockets.push(this);
  }

  send(value: string): void {
    this.sent.push(value);
  }

  close(code = 1006, reason = ''): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(closeEvent(code, reason));
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  message(value: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
  }

  fail(): void {
    this.dispatchEvent(new Event('error'));
  }
}

beforeEach(() => {
  sockets.length = 0;
  vi.stubGlobal('WebSocket', MockWebSocket);
  vi.stubGlobal('window', { location: { href: 'https://example.test/' } });
  vi.stubGlobal('localStorage', {
    setItem: vi.fn(),
  });
});

function closeEvent(code: number, reason: string): Event {
  const event = new Event('close');
  Object.defineProperties(event, {
    code: { value: code },
    reason: { value: reason },
  });
  return event;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Worker creation transport', () => {
  test('advertises the racing surface as read-only', () => {
    expect(supportsRaceActions).toBe(false);
  });

  test('shares one in-flight invited join and persists before publishing', async () => {
    const publicationOrder: string[] = [];
    const setItem = vi.fn((key: string) =>
      publicationOrder.push(key.endsWith('.membership') ? 'membership' : 'last-room'),
    );
    vi.stubGlobal('localStorage', { setItem });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { roomCode: 'ABCD', playerId: PLAYER_ID, rejoinCredential: CREDENTIAL },
          { status: 201 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const unsubscribe = subscribe({
      onMessage: vi.fn(() => publicationOrder.push('published')),
      onConnect: vi.fn(),
      onDisconnect: vi.fn(),
    });

    const first = joinRoom('Guest', 'abcd');
    const second = joinRoom('Guest', 'ABCD');
    expect(second).toBe(first);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/rooms/ABCD/memberships');
    sockets[0]!.open();
    sockets[0]!.message({
      type: 'room/sync',
      room: workerTransportLobby(),
      you: PLAYER_ID,
      at: 1,
    });

    await expect(first).resolves.toBeUndefined();
    expect(publicationOrder).toEqual(['membership', 'last-room', 'published']);
    unsubscribe();
  });

  test('shares one in-flight creation and resolves only after the first lobby sync', async () => {
    const publicationOrder: string[] = [];
    const setItem = vi.fn((key: string) => {
      publicationOrder.push(key.endsWith('.membership') ? 'membership' : 'last-room');
    });
    vi.stubGlobal('localStorage', { setItem });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { roomCode: 'ABCD', playerId: PLAYER_ID, rejoinCredential: CREDENTIAL },
          { status: 201 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const first = createRoom('Ada');
    const second = createRoom('Ada');
    expect(second).toBe(first);

    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const socket = sockets[0]!;
    socket.open();
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      type: 'room/connect',
      playerId: PLAYER_ID,
      rejoinCredential: CREDENTIAL,
    });

    let settled = false;
    const onMessage = vi.fn(() => {
      publicationOrder.push('published');
    });
    const unsubscribe = subscribe({
      onMessage,
      onConnect: vi.fn(),
      onDisconnect: vi.fn(),
    });
    void first.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    socket.message({
      type: 'room/sync',
      room: workerTransportLobby(),
      you: PLAYER_ID,
      at: 1,
    });
    await expect(first).resolves.toBeUndefined();
    expect(settled).toBe(true);
    expect(setItem).toHaveBeenCalledWith(
      'wikispeedrun.room.ABCD.membership',
      JSON.stringify({
        playerId: PLAYER_ID,
        rejoinCredential: CREDENTIAL,
      }),
    );
    expect(publicationOrder).toEqual(['membership', 'last-room', 'published']);
    unsubscribe();
  });

  test('storage failure rejects creation without publishing the lobby and permits retry', async () => {
    const setItem = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('quota exceeded');
      })
      .mockImplementationOnce(() => undefined);
    vi.stubGlobal('localStorage', { setItem });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json(
            { roomCode: 'ABCD', playerId: PLAYER_ID, rejoinCredential: CREDENTIAL },
            { status: 201 },
          ),
        )
        .mockResolvedValueOnce(
          Response.json(
            { roomCode: 'EFGH', playerId: PLAYER_ID, rejoinCredential: CREDENTIAL },
            { status: 201 },
          ),
        ),
    );
    const onMessage = vi.fn();
    const onDisconnect = vi.fn();
    const unsubscribe = subscribe({
      onMessage,
      onConnect: vi.fn(),
      onDisconnect,
    });

    const first = createRoom('Ada');
    await expect(first).rejects.toThrow('The Room membership could not be saved.');
    expect(onMessage).not.toHaveBeenCalled();
    expect(onDisconnect).toHaveBeenCalledWith({
      type: 'terminal',
      code: 'internal-error',
      message: 'The Room membership could not be saved.',
    });
    expect(sockets).toHaveLength(0);

    const retry = createRoom('Ada');
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.open();
    sockets[0]!.message({
      type: 'room/sync',
      room: { ...workerTransportLobby(), code: 'EFGH' },
      you: PLAYER_ID,
      at: 1,
    });
    await expect(retry).resolves.toBeUndefined();
    expect(onMessage).toHaveBeenCalledOnce();
    expect(setItem).toHaveBeenCalledTimes(3);
    unsubscribe();
  });

  test('last-Room pointer failure prevents authentication and promotion', async () => {
    const setItem = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error('storage blocked');
      });
    vi.stubGlobal('localStorage', { setItem });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { roomCode: 'ABCD', playerId: PLAYER_ID, rejoinCredential: CREDENTIAL },
            { status: 201 },
          ),
        ),
    );

    await expect(createRoom('Ada')).rejects.toThrow('The Room membership could not be saved.');
    expect(setItem).toHaveBeenNthCalledWith(
      1,
      'wikispeedrun.room.ABCD.membership',
      expect.any(String),
    );
    expect(setItem).toHaveBeenNthCalledWith(2, 'wikispeedrun.lastRoom', 'ABCD');
    expect(sockets).toHaveLength(0);
  });

  test('clears the guard after a terminal creation failure', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(
        Response.json(
          { roomCode: 'EFGH', playerId: PLAYER_ID, rejoinCredential: CREDENTIAL },
          { status: 201 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(createRoom('Ada')).rejects.toThrow('could not be reached');
    const retry = createRoom('Ada');
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(sockets).toHaveLength(1);
    });
    sockets[0]!.open();
    sockets[0]!.message({
      type: 'room/sync',
      room: { ...workerTransportLobby(), code: 'EFGH' },
      you: PLAYER_ID,
      at: 1,
    });
    await expect(retry).resolves.toBeUndefined();
  });

  test('post-sync close reconnects with the same Membership', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { roomCode: 'ABCD', playerId: PLAYER_ID, rejoinCredential: CREDENTIAL },
            { status: 201 },
          ),
        ),
    );
    const onDisconnect = vi.fn();
    const unsubscribe = subscribe({
      onMessage: vi.fn(),
      onConnect: vi.fn(),
      onDisconnect,
    });

    const creation = createRoom('Ada');
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.open();
    sockets[0]!.message({
      type: 'room/sync',
      room: workerTransportLobby(),
      you: PLAYER_ID,
      at: 1,
    });
    await creation;
    sockets[0]!.close();

    expect(onDisconnect).toHaveBeenCalledOnce();
    expect(onDisconnect).toHaveBeenCalledWith({ type: 'reconnecting' });
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    sockets[1]!.open();
    expect(JSON.parse(sockets[1]!.sent[0]!)).toEqual({
      type: 'room/connect',
      playerId: PLAYER_ID,
      rejoinCredential: CREDENTIAL,
    });
    sockets[1]!.message({
      type: 'room/sync',
      room: workerTransportLobby(),
      you: PLAYER_ID,
      at: 2,
    });
    unsubscribe();
  });

  test('replacement error terminates without starting a reconnect fight', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { roomCode: 'ABCD', playerId: PLAYER_ID, rejoinCredential: CREDENTIAL },
            { status: 201 },
          ),
        ),
    );
    const onDisconnect = vi.fn();
    const unsubscribe = subscribe({
      onMessage: vi.fn(),
      onConnect: vi.fn(),
      onDisconnect,
    });
    const creation = createRoom('Ada');
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.open();
    sockets[0]!.message({
      type: 'room/sync',
      room: workerTransportLobby(),
      you: PLAYER_ID,
      at: 1,
    });
    await creation;
    sockets[0]!.message({
      type: 'room/error',
      code: 'connection-replaced',
      message: 'This Room Membership was opened in another tab.',
    });
    await Promise.resolve();

    expect(onDisconnect).toHaveBeenLastCalledWith({
      type: 'terminal',
      code: 'connection-replaced',
      message: 'This Room Membership was opened in another tab.',
    });
    expect(sockets).toHaveLength(1);
    unsubscribe();
  });

  test('reconnect retry exhaustion terminates instead of looping', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { roomCode: 'ABCD', playerId: PLAYER_ID, rejoinCredential: CREDENTIAL },
            { status: 201 },
          ),
        ),
    );
    const onDisconnect = vi.fn();
    const unsubscribe = subscribe({
      onMessage: vi.fn(),
      onConnect: vi.fn(),
      onDisconnect,
    });
    const creation = createRoom('Ada');
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.open();
    sockets[0]!.message({
      type: 'room/sync',
      room: workerTransportLobby(),
      you: PLAYER_ID,
      at: 1,
    });
    await creation;

    sockets[0]!.close();
    expect(sockets).toHaveLength(2);
    sockets[1]!.fail();
    await vi.advanceTimersByTimeAsync(250);
    expect(sockets).toHaveLength(3);
    sockets[2]!.fail();
    await vi.advanceTimersByTimeAsync(500);
    expect(sockets).toHaveLength(4);
    sockets[3]!.fail();
    await vi.advanceTimersByTimeAsync(0);

    expect(onDisconnect).toHaveBeenLastCalledWith({
      type: 'terminal',
      code: 'room-unavailable',
      message: 'The Room connection could not be restored.',
    });
    expect(sockets).toHaveLength(4);
    unsubscribe();
  });

  test('stalled creation request times out and permits retry', async () => {
    vi.useFakeTimers();
    const observed: { signal?: AbortSignal } = {};
    const fetchMock = vi
      .fn()
      .mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.signal) observed.signal = init.signal;
        return new Promise<Response>(() => undefined);
      })
      .mockResolvedValueOnce(
        Response.json(
          { roomCode: 'EFGH', playerId: PLAYER_ID, rejoinCredential: CREDENTIAL },
          { status: 201 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const first = createRoom('Ada');
    const rejection = expect(first).rejects.toThrow('Room request timed out.');
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    expect(observed.signal?.aborted).toBe(true);

    const retry = createRoom('Ada');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(1);
    sockets[0]!.open();
    sockets[0]!.message({
      type: 'room/sync',
      room: { ...workerTransportLobby(), code: 'EFGH' },
      you: PLAYER_ID,
      at: 1,
    });
    await expect(retry).resolves.toBeUndefined();
  });

  test('stalled Membership response body remains inside the request deadline', async () => {
    vi.useFakeTimers();
    const response = new Response(null, { status: 201 });
    vi.spyOn(response, 'json').mockImplementation(() => new Promise(() => undefined));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    const creation = createRoom('Ada');
    const rejection = expect(creation).rejects.toThrow('Room request timed out.');
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    expect(sockets).toHaveLength(0);
  });

  test('a timed-out join response retries with the same attempt id', async () => {
    vi.useFakeTimers();
    const firstResponse = new Response(null, { status: 201 });
    vi.spyOn(firstResponse, 'json').mockImplementation(() => new Promise(() => undefined));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(firstResponse)
      .mockResolvedValueOnce(
        Response.json(
          { roomCode: 'ABCD', playerId: PLAYER_ID, rejoinCredential: CREDENTIAL },
          { status: 201 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const joined = joinRoom('Guest', 'ABCD');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      playerName: string;
      attemptId: string;
      generation: number;
    };
    const retryBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      playerName: string;
      attemptId: string;
      generation: number;
    };
    expect(firstBody.playerName).toBe('Guest');
    expect(firstBody.attemptId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(firstBody.generation).toBe(0);
    expect(retryBody).toEqual({ ...firstBody, generation: 1 });

    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.open();
    sockets[0]!.message({
      type: 'room/sync',
      room: workerTransportLobby(),
      you: PLAYER_ID,
      at: 1,
    });
    await expect(joined).resolves.toBeUndefined();
  });

  test('stalled first sync closes the socket and permits retry', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json(
            { roomCode: 'ABCD', playerId: PLAYER_ID, rejoinCredential: CREDENTIAL },
            { status: 201 },
          ),
        )
        .mockResolvedValueOnce(
          Response.json(
            { roomCode: 'EFGH', playerId: PLAYER_ID, rejoinCredential: CREDENTIAL },
            { status: 201 },
          ),
        ),
    );

    const first = createRoom('Ada');
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(1);
    sockets[0]!.open();
    const rejection = expect(first).rejects.toThrow('lobby did not become ready');
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    expect(sockets[0]!.readyState).toBe(3);

    const retry = createRoom('Ada');
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    sockets[1]!.message({
      type: 'room/sync',
      room: { ...workerTransportLobby(), code: 'EFGH' },
      you: PLAYER_ID,
      at: 1,
    });
    await expect(retry).resolves.toBeUndefined();
  });

  test('malformed first frame closes the socket and permits retry', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json(
            { roomCode: 'ABCD', playerId: PLAYER_ID, rejoinCredential: CREDENTIAL },
            { status: 201 },
          ),
        )
        .mockResolvedValueOnce(
          Response.json(
            { roomCode: 'EFGH', playerId: PLAYER_ID, rejoinCredential: CREDENTIAL },
            { status: 201 },
          ),
        ),
    );
    const onDisconnect = vi.fn();
    const unsubscribe = subscribe({
      onMessage: vi.fn(),
      onConnect: vi.fn(),
      onDisconnect,
    });

    const first = createRoom('Ada');
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.open();
    sockets[0]!.message({ type: 'not-a-server-message' });
    await expect(first).rejects.toThrow('invalid lobby response');
    expect(sockets[0]!.readyState).toBe(3);
    expect(onDisconnect).toHaveBeenCalledWith({
      type: 'terminal',
      code: 'internal-error',
      message: 'The Room service sent an invalid lobby response.',
    });

    const retry = createRoom('Ada');
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    sockets[1]!.open();
    sockets[1]!.message({
      type: 'room/sync',
      room: { ...workerTransportLobby(), code: 'EFGH' },
      you: PLAYER_ID,
      at: 1,
    });
    await expect(retry).resolves.toBeUndefined();
    unsubscribe();
  });
});
