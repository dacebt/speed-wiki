import { ARTICLE_POOL } from '../game/articles.js';

// Article selection is shell territory: it involves randomness and (in hard
// mode) network I/O. The chosen pair enters the core as data on an intent.

const ACTION_API = 'https://en.wikipedia.org/w/api.php';
const HARD_MODE_FETCH_TIMEOUT_MS = 6_000;

export interface ArticlePair {
  startArticle: string;
  goalArticle: string;
}

export function pickCuratedPair(): ArticlePair {
  const start = Math.floor(Math.random() * ARTICLE_POOL.length);
  let goal = Math.floor(Math.random() * (ARTICLE_POOL.length - 1));
  if (goal >= start) goal += 1;
  return { startArticle: ARTICLE_POOL[start]!, goalArticle: ARTICLE_POOL[goal]! };
}

/** Hard mode: two true-random articles. Falls back to the curated pool if the API fails. */
export async function pickRandomPair(): Promise<ArticlePair> {
  try {
    const url = `${ACTION_API}?action=query&list=random&rnnamespace=0&rnlimit=2&format=json`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(HARD_MODE_FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': 'WikiSpeedrun/0.1 (party game prototype)' },
    });
    if (!res.ok) throw new Error(`Action API returned ${res.status}`);
    const data = (await res.json()) as { query?: { random?: Array<{ title?: string }> } };
    const titles = (data.query?.random ?? []).map((r) => r.title).filter(
      (t): t is string => typeof t === 'string' && t.length > 0,
    );
    const [startArticle, goalArticle] = titles;
    if (!startArticle || !goalArticle || startArticle === goalArticle) {
      throw new Error('Action API returned unusable titles');
    }
    return { startArticle, goalArticle };
  } catch (err) {
    console.warn('hard-mode random fetch failed, falling back to curated pool:', err);
    return pickCuratedPair();
  }
}

export function pickPair(hardMode: boolean): Promise<ArticlePair> {
  return hardMode ? pickRandomPair() : Promise.resolve(pickCuratedPair());
}
