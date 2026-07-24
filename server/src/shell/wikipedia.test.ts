import { afterEach, describe, expect, test, vi } from 'vitest';
import { CATEGORY_PAIRS } from '@wikispeedrun/game';
import { pickPair } from './wikipedia.js';

function stubRandomFetch(titles: string[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ query: { random: titles.map((title) => ({ title })) } }),
    }),
  );
}

// Warrant: this locks the reproduced silent-fallback bug — a failed random fetch
// used to be swapped for a curated pair without anyone knowing.
describe('article selection honesty', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('random difficulty surfaces the failure instead of silently serving curated', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await expect(pickPair('random', 'any')).rejects.toThrow();
  });

  test('curated difficulty needs no network', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('curated must not touch the network')),
    );
    const pair = await pickPair('curated', 'any');
    expect(pair.startArticle).toBeTruthy();
    expect(pair.goalArticle).toBeTruthy();
    expect(pair.startArticle).not.toBe(pair.goalArticle);
  });
});

describe('category selection', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('a curated category constrains the pair to that category', async () => {
    const pair = await pickPair('curated', 'science');
    const inCategory = CATEGORY_PAIRS.science.some(
      (p) => p.start === pair.startArticle && p.goal === pair.goalArticle,
    );
    expect(inCategory).toBe(true);
  });

  test('random ignores the category and uses the fetched articles', async () => {
    stubRandomFetch(['Quasar', 'Cheese']);
    const pair = await pickPair('random', 'science');
    expect(pair).toEqual({ startArticle: 'Quasar', goalArticle: 'Cheese' });
  });
});
