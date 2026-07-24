import type { Category, Difficulty } from '@wikispeedrun/shared';
import { ARTICLE_POOL, CATEGORY_PAIRS } from '@wikispeedrun/game';

const ACTION_API = 'https://en.wikipedia.org/w/api.php';
const RANDOM_FETCH_TIMEOUT_MS = 6_000;
const RANDOM_FETCH_ATTEMPTS = 3;

export interface ArticlePair {
  startArticle: string;
  goalArticle: string;
}

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

function parseRandomPair(value: unknown): ArticlePair {
  if (!isRecord(value) || !isRecord(value.query) || !Array.isArray(value.query.random)) {
    throw new Error('Wikipedia returned an invalid random-article response.');
  }
  if (value.query.random.length !== 2) {
    throw new Error('Wikipedia did not return exactly two random articles.');
  }
  const titles = value.query.random.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.title !== 'string' ||
      entry.title.trim().length === 0 ||
      entry.title !== entry.title.trim()
    ) {
      throw new Error('Wikipedia returned an invalid random article.');
    }
    return entry.title;
  });
  const [startArticle, goalArticle] = titles;
  if (!startArticle || !goalArticle || startArticle === goalArticle) {
    throw new Error('Wikipedia returned unusable random articles.');
  }
  return { startArticle, goalArticle };
}

async function fetchRandomPair(): Promise<ArticlePair> {
  const url = `${ACTION_API}?action=query&list=random&rnnamespace=0&rnlimit=2&format=json`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(RANDOM_FETCH_TIMEOUT_MS),
    headers: { 'User-Agent': 'WikiSpeedrun/0.1 (party game prototype)' },
  });
  if (!response.ok) throw new Error(`Wikipedia returned ${response.status}.`);
  return parseRandomPair(await response.json());
}

async function pickRandomPair(): Promise<ArticlePair> {
  let lastError: unknown;
  for (let attempt = 0; attempt < RANDOM_FETCH_ATTEMPTS; attempt += 1) {
    try {
      return await fetchRandomPair();
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `Random article selection failed after ${RANDOM_FETCH_ATTEMPTS} attempts: ${String(lastError)}`,
  );
}

export function pickPair(difficulty: Difficulty, category: Category): Promise<ArticlePair> {
  return difficulty === 'random' ? pickRandomPair() : Promise.resolve(pickCuratedPair(category));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
