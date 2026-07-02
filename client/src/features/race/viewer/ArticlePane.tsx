import { useEffect, useRef, useState } from 'react';
import { classifyLink, fetchArticle } from './wiki';
import './article.css';

interface ArticlePaneProps {
  title: string;
  /** Called when a requested article has loaded, with its canonical title. */
  onArrived: (canonicalTitle: string) => void;
  /** Called when the user clicks a legal article link. */
  onNavigate: (title: string) => void;
  /** Called when the user clicks an out-of-bounds link. */
  onBlocked: () => void;
  /** When true (finished/conceded), link clicks are inert. */
  frozen: boolean;
}

interface PaneState {
  html: string;
  loadedTitle: string | null;
  loading: boolean;
  error: string | null;
}

export function ArticlePane({ title, onArrived, onNavigate, onBlocked, frozen }: ArticlePaneProps) {
  const [pane, setPane] = useState<PaneState>({
    html: '',
    loadedTitle: null,
    loading: true,
    error: null,
  });
  const paneRef = useRef<HTMLDivElement>(null);
  const onArrivedRef = useRef(onArrived);
  onArrivedRef.current = onArrived;

  useEffect(() => {
    let cancelled = false;
    setPane((s) => ({ ...s, loading: true, error: null }));
    fetchArticle(title)
      .then((article) => {
        if (cancelled) return;
        setPane({
          html: article.html,
          loadedTitle: article.canonicalTitle,
          loading: false,
          error: null,
        });
        paneRef.current?.scrollTo(0, 0);
        onArrivedRef.current(article.canonicalTitle);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'The page could not be fetched.';
        setPane((s) => ({ ...s, loading: false, error: message }));
      });
    return () => {
      cancelled = true;
    };
  }, [title]);

  function handleClick(e: React.MouseEvent) {
    const anchor = (e.target as HTMLElement).closest('a');
    if (!anchor) return;
    e.preventDefault();
    if (frozen || pane.loading) return;

    const link = classifyLink(anchor);
    switch (link.kind) {
      case 'fragment': {
        document.getElementById(link.targetId)?.scrollIntoView({ behavior: 'smooth' });
        return;
      }
      case 'article':
        onNavigate(link.title);
        return;
      case 'blocked':
        onBlocked();
    }
  }

  return (
    <div className="article-pane" ref={paneRef}>
      {pane.error && <div className="article-pane__error flavor">{pane.error}</div>}
      <h1 className="article-pane__title">{pane.loadedTitle ?? title}</h1>
      {/* Sanitized by DOMPurify in fetchArticle before it ever reaches state. */}
      <div
        className="article-pane__body"
        onClick={handleClick}
        dangerouslySetInnerHTML={{ __html: pane.html }}
      />
      {pane.loading && <div className="article-pane__loading flavor">Loading article…</div>}
    </div>
  );
}
