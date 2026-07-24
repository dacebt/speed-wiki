import type { Category, Difficulty } from '@wikispeedrun/shared';
import { ARTICLE_POOL, CATEGORY_PAIRS } from '@wikispeedrun/game';

// Article selection is shell territory: it involves randomness and (for random
// difficulty) network I/O. The chosen pair enters the core as data on an intent.

const ACTION_API = 'https://en.wikipedia.org/w/api.php';
const RANDOM_FETCH_TIMEOUT_MS = 6_000;
const RANDOM_FETCH_ATTEMPTS = 3;

export interface ArticlePair {
  startArticle: string;
  goalArticle: string;
}

// 'any' keeps the original behavior: two distinct articles from the flat pool.
// A specific category draws one of its hand-picked, reachable start/goal pairs.
function pickCuratedPair(category: Category): ArticlePair {
  if (category !== 'any') {
    const pairs = CATEGORY_PAIRS[category];
    const pair = pairs[Math.floor(Math.random() * pairs.length)]!;
    return { startArticle: pair.start, goalArticle: pair.goal };
  }
  const start = Math.floor(Math.random() * ARTICLE_POOL.length);
  let goal = Math.floor(Math.random() * (ARTICLE_POOL.length - 1));
  if (goal >= start) goal += 1;
  return { startArticle: ARTICLE_POOL[start]!, goalArticle: ARTICLE_POOL[goal]! };
}

/** One attempt at two true-random articles; throws on any unusable response. */
async function fetchRandomPair(): Promise<ArticlePair> {
  const url = `${ACTION_API}?action=query&list=random&rnnamespace=0&rnlimit=2&format=json`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(RANDOM_FETCH_TIMEOUT_MS),
    headers: { 'User-Agent': 'WikiSpeedrun/0.1 (party game prototype)' },
  });
  if (!res.ok) throw new Error(`Action API returned ${res.status}`);
  const data = (await res.json()) as { query?: { random?: Array<{ title?: string }> } };
  const titles = (data.query?.random ?? [])
    .map((r) => r.title)
    .filter((t): t is string => typeof t === 'string' && t.length > 0);
  const [startArticle, goalArticle] = titles;
  if (!startArticle || !goalArticle || startArticle === goalArticle) {
    throw new Error('Action API returned unusable titles');
  }
  return { startArticle, goalArticle };
}

/** Random difficulty: two true-random articles, retried within a bounded budget.
    On exhaustion it throws — it never silently substitutes the curated pool, so
    a random round is genuinely random or the room is told it failed. */
async function pickRandomPair(): Promise<ArticlePair> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= RANDOM_FETCH_ATTEMPTS; attempt++) {
    try {
      return await fetchRandomPair();
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    `random article fetch failed after ${RANDOM_FETCH_ATTEMPTS} attempts: ${String(lastError)}`,
  );
}

// Category × difficulty: category constrains the curated path only. Random draws
// from all of Wikipedia and ignores the category — the one non-contradictory
// combination (the lobby disables the category picker under random to match).
export function pickPair(difficulty: Difficulty, category: Category): Promise<ArticlePair> {
  return difficulty === 'random' ? pickRandomPair() : Promise.resolve(pickCuratedPair(category));
}
