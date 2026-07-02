import DOMPurify from 'dompurify';

// Wikipedia fetching, sanitizing, and link classification — the viewer's
// core, isolated so fetching could move behind our server without touching
// the rest of the race feature.

const REST_HTML_BASE = 'https://en.wikipedia.org/api/rest_v1/page/html/';

export interface FetchedArticle {
  /** Canonical title after following redirects, derived from the final URL. */
  canonicalTitle: string;
  /** Sanitized article body HTML, safe to inject. */
  html: string;
}

export async function fetchArticle(title: string): Promise<FetchedArticle> {
  const res = await fetch(REST_HTML_BASE + encodeURIComponent(title.replaceAll(' ', '_')), {
    headers: { Accept: 'text/html' },
  });
  if (res.status === 404) throw new Error(`No page in the Encyclopédie is titled “${title}”.`);
  if (!res.ok) throw new Error(`Wikipedia returned ${res.status}.`);
  const raw = await res.text();
  return { canonicalTitle: titleFromRestUrl(res.url) ?? title, html: sanitizeArticle(raw) };
}

function titleFromRestUrl(url: string): string | null {
  const match = /\/page\/html\/([^?#]+)/.exec(url);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]).replaceAll('_', ' ');
  } catch {
    return null;
  }
}

function sanitizeArticle(rawHtml: string): string {
  const doc = new DOMParser().parseFromString(rawHtml, 'text/html');

  // Noise and navigation escape hatches removed before sanitizing.
  const STRIP_SELECTORS = [
    'style',
    'link',
    'span.mw-editsection',
    '.navbox',
    '.vertical-navbox',
    '.mw-authority-control',
    'table.metadata',
  ];
  doc.querySelectorAll(STRIP_SELECTORS.join(',')).forEach((el) => el.remove());

  return DOMPurify.sanitize(doc.body.innerHTML, {
    FORBID_TAGS: ['form', 'input', 'iframe', 'object', 'embed', 'audio', 'video', 'style'],
    FORBID_ATTR: ['onclick', 'onerror', 'onload', 'srcset'],
    // Parsoid marks internal links rel="mw:WikiLink" — needed for routing.
    ADD_ATTR: ['rel'],
  });
}

const BLOCKED_NAMESPACES =
  /^(File|Category|Help|Wikipedia|Special|Talk|Portal|Template|Template talk|Draft|Module|MediaWiki):/i;

export type LinkTarget =
  | { kind: 'fragment'; targetId: string }
  | { kind: 'article'; title: string }
  | { kind: 'blocked' };

export function classifyLink(anchor: HTMLAnchorElement): LinkTarget {
  const href = anchor.getAttribute('href') ?? '';
  const rel = anchor.getAttribute('rel') ?? '';

  if (href.startsWith('#')) return { kind: 'fragment', targetId: href.slice(1) };

  if (rel.includes('mw:WikiLink') || href.startsWith('./')) {
    let title: string;
    try {
      title = decodeURIComponent(href.replace(/^\.\//, '').split('#')[0] ?? '');
    } catch {
      return { kind: 'blocked' };
    }
    title = title.replaceAll('_', ' ');
    if (title.length === 0 || BLOCKED_NAMESPACES.test(title)) return { kind: 'blocked' };
    if (anchor.classList.contains('new')) return { kind: 'blocked' };
    return { kind: 'article', title };
  }

  return { kind: 'blocked' };
}
