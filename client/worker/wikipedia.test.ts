import { afterEach, describe, expect, test, vi } from 'vitest';
import { pickPair } from './wikipedia.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Worker Wikipedia article selection', () => {
  test('selects a category pair without network access', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(Math, 'random').mockReturnValue(0);

    await expect(pickPair('curated', 'science')).resolves.toEqual({
      startArticle: 'Albert Einstein',
      goalArticle: 'Physics',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('accepts exactly two distinct titled random articles', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          query: {
            random: [
              { id: 1, ns: 0, title: 'Ada Lovelace' },
              { id: 2, ns: 0, title: 'Analytical Engine' },
            ],
          },
        }),
      ),
    );

    await expect(pickPair('random', 'history')).resolves.toEqual({
      startArticle: 'Ada Lovelace',
      goalArticle: 'Analytical Engine',
    });
  });

  test('rejects malformed random responses after the bounded retry budget', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ query: { random: [{ title: 'Only one' }] } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(pickPair('random', 'any')).rejects.toThrow(
      'Random article selection failed after 3 attempts',
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test('rejects random titles with outer whitespace at the Wikipedia boundary', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        query: {
          random: [{ title: ' Ada Lovelace' }, { title: 'Analytical Engine' }],
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(pickPair('random', 'any')).rejects.toThrow(
      'Random article selection failed after 3 attempts',
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test('never substitutes a curated pair after random fetch failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(Math, 'random').mockReturnValue(0);

    await expect(pickPair('random', 'science')).rejects.toThrow(
      'Random article selection failed after 3 attempts',
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
