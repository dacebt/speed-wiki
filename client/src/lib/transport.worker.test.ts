import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoom, subscribe } from './transport.worker.js';
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

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  message(value: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
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

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Worker creation transport', () => {
  test('shares one in-flight creation and resolves only after the first lobby sync', async () => {
    const publicationOrder: string[] = [];
    const setItem = vi.fn(() => {
      publicationOrder.push('persisted');
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
    expect(publicationOrder).toEqual(['persisted', 'published']);
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
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.open();
    sockets[0]!.message({
      type: 'room/sync',
      room: workerTransportLobby(),
      you: PLAYER_ID,
      at: 1,
    });

    await expect(first).rejects.toThrow('The Room membership could not be saved.');
    expect(onMessage).not.toHaveBeenCalled();
    expect(onDisconnect).toHaveBeenCalledWith({
      type: 'terminal',
      code: 'internal-error',
      message: 'The Room membership could not be saved.',
    });
    expect(sockets[0]!.readyState).toBe(3);

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
    expect(onMessage).toHaveBeenCalledOnce();
    expect(setItem).toHaveBeenCalledTimes(2);
    unsubscribe();
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

  test('post-sync close publishes a terminal disconnect', async () => {
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
    expect(onDisconnect).toHaveBeenCalledWith({
      type: 'terminal',
      code: 'room-unavailable',
      message: 'The Room connection was lost. Create a new Room to continue.',
    });
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
    const rejection = expect(first).rejects.toThrow('Room creation timed out.');
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
      code: 'room-unavailable',
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
