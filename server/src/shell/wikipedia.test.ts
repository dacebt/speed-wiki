import { afterEach, describe, expect, test, vi } from 'vitest';
import { pickPair } from './wikipedia.js';

// Warrant: this locks the reproduced silent-fallback bug — a failed random fetch
// used to be swapped for a curated pair without anyone knowing.
describe('article selection honesty', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('random difficulty surfaces the failure instead of silently serving curated', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await expect(pickPair('random')).rejects.toThrow();
  });

  test('curated difficulty needs no network', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('curated must not touch the network')),
    );
    const pair = await pickPair('curated');
    expect(pair.startArticle).toBeTruthy();
    expect(pair.goalArticle).toBeTruthy();
    expect(pair.startArticle).not.toBe(pair.goalArticle);
  });
});
