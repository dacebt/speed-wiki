import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CREDENTIAL, PLAYER_ID, workerTransportLobby } from './transport.worker.fixtures.js';

const sockets: LifecycleSocket[] = [];
const NEW_PLAYER_ID = 'c61ecdb5-0476-4503-953b-04567336f436';
const NEW_CREDENTIAL = 'B'.repeat(43);

class LifecycleSocket extends EventTarget {
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
    this.readyState = LifecycleSocket.OPEN;
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
  vi.resetModules();
  sockets.length = 0;
  vi.stubGlobal('WebSocket', LifecycleSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Worker Connection ownership', () => {
  test('StrictMode subscription replay starts one stored-Membership resume', async () => {
    stubBrowser('');
    const transport = await import('./transport.worker.js');
    const handlers = {
      onMessage: vi.fn(),
      onConnect: vi.fn(),
      onDisconnect: vi.fn(),
    };

    const firstCleanup = transport.subscribe(handlers);
    firstCleanup();
    const finalCleanup = transport.subscribe(handlers);
    await Promise.resolve();

    expect(sockets).toHaveLength(1);
    sockets[0]!.open();
    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({
      type: 'room/connect',
      playerId: PLAYER_ID,
      rejoinCredential: CREDENTIAL,
    });
    sockets[0]!.message({
      type: 'room/sync',
      room: workerTransportLobby(),
      you: PLAYER_ID,
      at: 1,
    });
    expect(handlers.onMessage).toHaveBeenCalledOnce();
    finalCleanup();
  });

  test('invite query takes precedence over the stored last Room', async () => {
    stubBrowser('?code=EFGH');
    const transport = await import('./transport.worker.js');
    expect(transport.claimStoredInvite('EFGH')).toBe('join');
    const cleanup = transport.subscribe({
      onMessage: vi.fn(),
      onConnect: vi.fn(),
      onDisconnect: vi.fn(),
    });
    await Promise.resolve();
    expect(sockets).toHaveLength(0);
    cleanup();
  });

  test('a same-Room invite resumes its valid stored Membership without a join request', async () => {
    stubBrowser('?code=ABCD');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const transport = await import('./transport.worker.js');

    expect(transport.claimStoredInvite('ABCD')).toBe('resume');
    const cleanup = transport.subscribe({
      onMessage: vi.fn(),
      onConnect: vi.fn(),
      onDisconnect: vi.fn(),
    });
    await Promise.resolve();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(1);
    sockets[0]!.open();
    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({
      type: 'room/connect',
      playerId: PLAYER_ID,
      rejoinCredential: CREDENTIAL,
    });
    cleanup();
  });

  test('a same-Room invite keeps its query when the durable room pointer cannot be updated', async () => {
    const membership = JSON.stringify({
      playerId: PLAYER_ID,
      rejoinCredential: CREDENTIAL,
    });
    vi.stubGlobal('window', {
      location: { href: 'https://example.test/?code=ABCD', search: '?code=ABCD' },
    });
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) =>
        key === 'wikispeedrun.room.ABCD.membership' ? membership : null,
      ),
      setItem: vi.fn(() => {
        throw new Error('storage unavailable');
      }),
      removeItem: vi.fn(),
    });
    const transport = await import('./transport.worker.js');

    expect(transport.claimStoredInvite('ABCD')).toBe('resume-with-query');
    const cleanup = transport.subscribe({
      onMessage: vi.fn(),
      onConnect: vi.fn(),
      onDisconnect: vi.fn(),
    });
    await Promise.resolve();

    expect(sockets).toHaveLength(1);
    sockets[0]!.open();
    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({
      type: 'room/connect',
      playerId: PLAYER_ID,
      rejoinCredential: CREDENTIAL,
    });
    cleanup();
  });

  test('a claimed invite Membership outranks an older last-Room pointer after query consumption', async () => {
    const storage = new Map([
      ['wikispeedrun.lastRoom', 'ABCD'],
      [
        'wikispeedrun.room.ABCD.membership',
        JSON.stringify({
          playerId: PLAYER_ID,
          rejoinCredential: CREDENTIAL,
        }),
      ],
      [
        'wikispeedrun.room.EFGH.membership',
        JSON.stringify({
          playerId: NEW_PLAYER_ID,
          rejoinCredential: NEW_CREDENTIAL,
        }),
      ],
    ]);
    const location = {
      href: 'https://example.test/?code=EFGH',
      search: '?code=EFGH',
    };
    vi.stubGlobal('window', { location });
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
      removeItem: vi.fn((key: string) => storage.delete(key)),
    });
    const transport = await import('./transport.worker.js');

    expect(transport.claimStoredInvite('EFGH')).toBe('resume');
    expect(storage.get('wikispeedrun.lastRoom')).toBe('EFGH');
    location.href = 'https://example.test/';
    location.search = '';
    const cleanup = transport.subscribe({
      onMessage: vi.fn(),
      onConnect: vi.fn(),
      onDisconnect: vi.fn(),
    });
    await Promise.resolve();

    expect(sockets).toHaveLength(1);
    expect(String(sockets[0]!.url)).toBe('wss://example.test/api/rooms/EFGH/websocket');
    sockets[0]!.open();
    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({
      type: 'room/connect',
      playerId: NEW_PLAYER_ID,
      rejoinCredential: NEW_CREDENTIAL,
    });
    cleanup();
    await Promise.resolve();

    vi.resetModules();
    const reloadedTransport = await import('./transport.worker.js');
    const reloadedCleanup = reloadedTransport.subscribe({
      onMessage: vi.fn(),
      onConnect: vi.fn(),
      onDisconnect: vi.fn(),
    });
    await Promise.resolve();

    expect(sockets).toHaveLength(2);
    expect(String(sockets[1]!.url)).toBe('wss://example.test/api/rooms/EFGH/websocket');
    sockets[1]!.open();
    expect(JSON.parse(sockets[1]!.sent[0]!)).toEqual({
      type: 'room/connect',
      playerId: NEW_PLAYER_ID,
      rejoinCredential: NEW_CREDENTIAL,
    });
    reloadedCleanup();
  });

  test.each([
    ['missing', null],
    ['invalid', JSON.stringify({ playerId: PLAYER_ID, rejoinCredential: 'invalid' })],
  ])(
    'a same-Room invite with %s stored Membership remains joinable',
    async (_label, membership) => {
      stubBrowser('?code=ABCD', membership);
      const transport = await import('./transport.worker.js');

      expect(transport.claimStoredInvite('ABCD')).toBe('join');
      const cleanup = transport.subscribe({
        onMessage: vi.fn(),
        onConnect: vi.fn(),
        onDisconnect: vi.fn(),
      });
      await Promise.resolve();

      expect(sockets).toHaveLength(0);
      cleanup();
    },
  );

  test('stored-Membership resume retries a transient pre-sync close and keeps identity', async () => {
    vi.useFakeTimers();
    stubBrowser('');
    const transport = await import('./transport.worker.js');
    const onMessage = vi.fn();
    const cleanup = transport.subscribe({
      onMessage,
      onConnect: vi.fn(),
      onDisconnect: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.open();
    sockets[0]!.close(1006, 'Network interrupted.');
    await vi.advanceTimersByTimeAsync(250);
    expect(sockets).toHaveLength(2);
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
    expect(onMessage).toHaveBeenCalledOnce();
    cleanup();
  });

  test('close-code-only replacement terminates without reconnecting', async () => {
    stubBrowser('');
    const transport = await import('./transport.worker.js');
    const onDisconnect = vi.fn();
    const cleanup = transport.subscribe({
      onMessage: vi.fn(),
      onConnect: vi.fn(),
      onDisconnect,
    });
    await Promise.resolve();
    sockets[0]!.open();
    sockets[0]!.message({
      type: 'room/sync',
      room: workerTransportLobby(),
      you: PLAYER_ID,
      at: 1,
    });
    sockets[0]!.close(4001, 'Connection replaced.');
    await Promise.resolve();

    expect(onDisconnect).toHaveBeenLastCalledWith({
      type: 'terminal',
      code: 'connection-replaced',
      message: 'This Room Membership was opened in another tab.',
    });
    expect(localStorage.removeItem).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(1);
    cleanup();
  });

  test.each([
    [1008, 'rate-limited', 'This Room Membership sent too many messages. Try again shortly.'],
    [1009, 'message-too-large', 'Room messages may be at most 4,096 UTF-8 bytes.'],
  ] as const)(
    'close-code-only policy failure %s terminates as %s and retains the Membership',
    async (closeCode, code, message) => {
      stubBrowser('');
      const transport = await import('./transport.worker.js');
      const onDisconnect = vi.fn();
      const cleanup = transport.subscribe({
        onMessage: vi.fn(),
        onConnect: vi.fn(),
        onDisconnect,
      });
      await Promise.resolve();
      sockets[0]!.open();
      sockets[0]!.message({
        type: 'room/sync',
        room: workerTransportLobby(),
        you: PLAYER_ID,
        at: 1,
      });

      sockets[0]!.close(closeCode, 'Structured error frame was lost.');
      await Promise.resolve();

      expect(onDisconnect).toHaveBeenLastCalledWith({
        type: 'terminal',
        code,
        message,
      });
      expect(sockets).toHaveLength(1);
      expect(localStorage.removeItem).not.toHaveBeenCalled();
      expect(localStorage.getItem('wikispeedrun.lastRoom')).toBe('ABCD');
      expect(localStorage.getItem('wikispeedrun.room.ABCD.membership')).toBe(
        JSON.stringify({
          playerId: PLAYER_ID,
          rejoinCredential: CREDENTIAL,
        }),
      );
      cleanup();
    },
  );

  test('a hop-limit error remains a visible, nonterminal Room message', async () => {
    stubBrowser('');
    const transport = await import('./transport.worker.js');
    const onMessage = vi.fn();
    const onDisconnect = vi.fn();
    const cleanup = transport.subscribe({
      onMessage,
      onConnect: vi.fn(),
      onDisconnect,
    });
    await Promise.resolve();
    sockets[0]!.open();
    sockets[0]!.message({
      type: 'room/sync',
      room: workerTransportLobby(),
      you: PLAYER_ID,
      at: 1,
    });
    const error = {
      type: 'room/error',
      code: 'hop-limit-reached',
      message: 'A Player may make at most 100 hops per round.',
    } as const;
    sockets[0]!.message(error);
    await Promise.resolve();

    expect(onMessage).toHaveBeenLastCalledWith(error);
    expect(onDisconnect).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'terminal' }));
    expect(sockets[0]!.readyState).toBe(LifecycleSocket.OPEN);
    expect(localStorage.removeItem).not.toHaveBeenCalled();
    cleanup();
  });

  test.each(['message-too-large', 'rate-limited'] as const)(
    'a %s policy error terminates the Connection but retains Membership storage',
    async (code) => {
      stubBrowser('');
      const transport = await import('./transport.worker.js');
      const onDisconnect = vi.fn();
      const cleanup = transport.subscribe({
        onMessage: vi.fn(),
        onConnect: vi.fn(),
        onDisconnect,
      });
      await Promise.resolve();
      sockets[0]!.open();
      sockets[0]!.message({
        type: 'room/sync',
        room: workerTransportLobby(),
        you: PLAYER_ID,
        at: 1,
      });
      sockets[0]!.message({
        type: 'room/error',
        code,
        message: 'Connection policy rejected the message.',
      });
      await Promise.resolve();

      expect(onDisconnect).toHaveBeenLastCalledWith({
        type: 'terminal',
        code,
        message: 'Connection policy rejected the message.',
      });
      expect(localStorage.removeItem).not.toHaveBeenCalled();
      expect(sockets).toHaveLength(1);
      cleanup();
    },
  );

  test('a kick deletes the stored Membership before publishing the terminal signal', async () => {
    stubBrowser('');
    const transport = await import('./transport.worker.js');
    const terminalOrder: string[] = [];
    vi.mocked(localStorage.removeItem).mockImplementation(() => {
      terminalOrder.push('deleted');
    });
    const cleanup = transport.subscribe({
      onMessage: vi.fn(),
      onConnect: vi.fn(),
      onDisconnect: vi.fn((event) => {
        if (event.type === 'terminal') terminalOrder.push(event.code);
      }),
    });
    await Promise.resolve();
    sockets[0]!.open();
    sockets[0]!.message({
      type: 'room/sync',
      room: workerTransportLobby(),
      you: PLAYER_ID,
      at: 1,
    });
    sockets[0]!.message({
      type: 'room/error',
      code: 'kicked',
      message: 'The host removed you from the Room.',
    });
    await Promise.resolve();

    expect(localStorage.removeItem).toHaveBeenCalledWith('wikispeedrun.room.ABCD.membership');
    expect(terminalOrder).toEqual(['deleted', 'kicked']);
    expect(sockets).toHaveLength(1);
    cleanup();
  });

  test('an invalid-membership close deletes the stored Membership without reconnecting', async () => {
    stubBrowser('');
    const transport = await import('./transport.worker.js');
    const onDisconnect = vi.fn();
    const cleanup = transport.subscribe({
      onMessage: vi.fn(),
      onConnect: vi.fn(),
      onDisconnect,
    });
    await Promise.resolve();
    sockets[0]!.open();
    sockets[0]!.message({
      type: 'room/sync',
      room: workerTransportLobby(),
      you: PLAYER_ID,
      at: 1,
    });
    sockets[0]!.close(4003, 'Membership invalid.');
    await Promise.resolve();

    expect(localStorage.removeItem).toHaveBeenCalledWith('wikispeedrun.room.ABCD.membership');
    expect(onDisconnect).toHaveBeenLastCalledWith({
      type: 'terminal',
      code: 'invalid-membership',
      message: 'The Room Membership is invalid.',
    });
    expect(sockets).toHaveLength(1);
    cleanup();
  });

  test('a storage deletion failure cannot suppress the kicked terminal signal', async () => {
    stubBrowser('');
    vi.mocked(localStorage.removeItem).mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    const transport = await import('./transport.worker.js');
    const onDisconnect = vi.fn();
    const cleanup = transport.subscribe({
      onMessage: vi.fn(),
      onConnect: vi.fn(),
      onDisconnect,
    });
    await Promise.resolve();
    sockets[0]!.open();
    sockets[0]!.message({
      type: 'room/sync',
      room: workerTransportLobby(),
      you: PLAYER_ID,
      at: 1,
    });
    sockets[0]!.message({
      type: 'room/error',
      code: 'kicked',
      message: 'The host removed you from the Room.',
    });
    await Promise.resolve();

    expect(localStorage.removeItem).toHaveBeenCalledWith('wikispeedrun.room.ABCD.membership');
    expect(onDisconnect).toHaveBeenLastCalledWith({
      type: 'terminal',
      code: 'kicked',
      message: 'The host removed you from the Room.',
    });
    expect(sockets).toHaveLength(1);
    cleanup();
  });

  test('a delayed stale retry cannot replace a newer Membership Connection', async () => {
    vi.useFakeTimers();
    stubBrowser('');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          {
            roomCode: 'EFGH',
            playerId: NEW_PLAYER_ID,
            rejoinCredential: NEW_CREDENTIAL,
          },
          { status: 201 },
        ),
      ),
    );
    const transport = await import('./transport.worker.js');
    const cleanup = transport.subscribe({
      onMessage: vi.fn(),
      onConnect: vi.fn(),
      onDisconnect: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.open();
    sockets[0]!.message({
      type: 'room/sync',
      room: workerTransportLobby(),
      you: PLAYER_ID,
      at: 1,
    });
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.close(1006, 'Network interrupted.');
    sockets[1]!.fail();

    const joined = transport.joinRoom('New Player', 'EFGH');
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(3);
    sockets[2]!.open();
    sockets[2]!.message({
      type: 'room/sync',
      room: { ...workerTransportLobby(), code: 'EFGH' },
      you: NEW_PLAYER_ID,
      at: 2,
    });
    await joined;
    await vi.advanceTimersByTimeAsync(250);
    expect(sockets).toHaveLength(3);
    cleanup();
  });

  test('replacement cancels a final reconnect attempt and stale callbacks cannot own the new session', async () => {
    vi.useFakeTimers();
    stubBrowser('');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          {
            roomCode: 'EFGH',
            playerId: NEW_PLAYER_ID,
            rejoinCredential: NEW_CREDENTIAL,
          },
          { status: 201 },
        ),
      ),
    );
    const transport = await import('./transport.worker.js');
    const onMessage = vi.fn();
    const onDisconnect = vi.fn();
    const cleanup = transport.subscribe({
      onMessage,
      onConnect: vi.fn(),
      onDisconnect,
    });

    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.open();
    sockets[0]!.message({
      type: 'room/sync',
      room: workerTransportLobby(),
      you: PLAYER_ID,
      at: 1,
    });
    sockets[0]!.close(1006, 'Network interrupted.');
    await vi.advanceTimersByTimeAsync(0);
    sockets[1]!.fail();
    await vi.advanceTimersByTimeAsync(250);
    sockets[2]!.fail();
    await vi.advanceTimersByTimeAsync(500);
    expect(sockets).toHaveLength(4);
    sockets[3]!.open();

    const joined = transport.joinRoom('New Player', 'EFGH');
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets[3]!.readyState).toBe(3);
    expect(sockets).toHaveLength(5);
    sockets[4]!.open();
    sockets[4]!.message({
      type: 'room/sync',
      room: { ...workerTransportLobby(), code: 'EFGH' },
      you: NEW_PLAYER_ID,
      at: 2,
    });
    await joined;

    sockets[3]!.message({
      type: 'room/sync',
      room: workerTransportLobby(),
      you: PLAYER_ID,
      at: 3,
    });
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onMessage.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        type: 'room/sync',
        you: NEW_PLAYER_ID,
        room: expect.objectContaining({ code: 'EFGH' }),
      }),
    );

    sockets[4]!.close(1006, 'New session network interruption.');
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(6);
    sockets[5]!.open();
    sockets[5]!.message({
      type: 'room/sync',
      room: { ...workerTransportLobby(), code: 'EFGH' },
      you: NEW_PLAYER_ID,
      at: 4,
    });
    expect(onDisconnect).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'terminal' }));
    expect(onMessage).toHaveBeenCalledTimes(3);
    cleanup();
  });

  test('a promoted connection lost before first sync reloads its pre-auth persisted Membership', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('window', {
      location: { href: 'https://example.test/?code=EFGH', search: '?code=EFGH' },
    });
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
      removeItem: vi.fn((key: string) => storage.delete(key)),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          {
            roomCode: 'EFGH',
            playerId: NEW_PLAYER_ID,
            rejoinCredential: NEW_CREDENTIAL,
          },
          { status: 201 },
        ),
      ),
    );
    const firstTransport = await import('./transport.worker.js');
    const firstCleanup = firstTransport.subscribe({
      onMessage: vi.fn(),
      onConnect: vi.fn(),
      onDisconnect: vi.fn(),
    });
    const joined = firstTransport.joinRoom('Guest', 'EFGH');
    const rejected = expect(joined).rejects.toThrow();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    expect(storage.get('wikispeedrun.lastRoom')).toBe('EFGH');
    expect(storage.get('wikispeedrun.room.EFGH.membership')).toBe(
      JSON.stringify({
        playerId: NEW_PLAYER_ID,
        rejoinCredential: NEW_CREDENTIAL,
      }),
    );

    sockets[0]!.open();
    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({
      type: 'room/connect',
      playerId: NEW_PLAYER_ID,
      rejoinCredential: NEW_CREDENTIAL,
    });
    sockets[0]!.close(1006, 'Connection dropped after server promotion.');
    await rejected;
    firstCleanup();

    vi.resetModules();
    vi.stubGlobal('window', {
      location: { href: 'https://example.test/?code=EFGH', search: '?code=EFGH' },
    });
    const resumedTransport = await import('./transport.worker.js');
    expect(resumedTransport.claimStoredInvite('EFGH')).toBe('resume');
    const onMessage = vi.fn();
    const resumedCleanup = resumedTransport.subscribe({
      onMessage,
      onConnect: vi.fn(),
      onDisconnect: vi.fn(),
    });
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    sockets[1]!.open();
    expect(JSON.parse(sockets[1]!.sent[0]!)).toEqual({
      type: 'room/connect',
      playerId: NEW_PLAYER_ID,
      rejoinCredential: NEW_CREDENTIAL,
    });
    sockets[1]!.message({
      type: 'room/sync',
      room: { ...workerTransportLobby(), code: 'EFGH' },
      you: NEW_PLAYER_ID,
      at: 2,
    });
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'room/sync', you: NEW_PLAYER_ID }),
    );
    resumedCleanup();
  });

  test('stored-resume retry exhaustion leaves the valid Membership discoverable', async () => {
    vi.useFakeTimers();
    stubBrowser('');
    const transport = await import('./transport.worker.js');
    const onDisconnect = vi.fn();
    const cleanup = transport.subscribe({
      onMessage: vi.fn(),
      onConnect: vi.fn(),
      onDisconnect,
    });
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.fail();
    await vi.advanceTimersByTimeAsync(250);
    sockets[1]!.fail();
    await vi.advanceTimersByTimeAsync(500);
    sockets[2]!.fail();
    await vi.advanceTimersByTimeAsync(0);

    expect(onDisconnect).toHaveBeenLastCalledWith({
      type: 'terminal',
      code: 'room-unavailable',
      message: 'The Room connection could not be restored.',
    });
    expect(localStorage.getItem('wikispeedrun.lastRoom')).toBe('ABCD');
    expect(localStorage.removeItem).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(3);
    cleanup();
  });
});

function stubBrowser(
  search: string,
  membership: string | null = JSON.stringify({
    playerId: PLAYER_ID,
    rejoinCredential: CREDENTIAL,
  }),
): void {
  vi.stubGlobal('window', {
    location: { href: `https://example.test/${search}`, search },
  });
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key: string) => {
      if (key === 'wikispeedrun.lastRoom') return 'ABCD';
      if (key === 'wikispeedrun.room.ABCD.membership') return membership;
      return null;
    }),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  });
}

function closeEvent(code: number, reason: string): Event {
  const event = new Event('close');
  Object.defineProperties(event, {
    code: { value: code },
    reason: { value: reason },
  });
  return event;
}
