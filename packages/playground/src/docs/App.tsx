// Top-level docs app: sidebar nav + content area.
//
// Three regions:
//   - Top header (brand + navigation back to the playground)
//   - Left sidebar (group → page nav, plus per-page outline once
//     a page is loaded)
//   - Main article (rendered Markdown for the active slug). The
//     article is wrapped in an error boundary so a `renderMarkdown`
//     throw (e.g. corrupted Markdown source) surfaces a "Failed to
//     render" panel instead of blank-pageing the whole docs SPA.

import {
  Component,
  type ErrorInfo,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
} from 'react';

import { DOC_GROUPS, findPage, type DocPage } from './pages';
import { hrefForSlug, useHashSlug } from './router';
import { extractOutline, renderMarkdown } from './markdown';

export function App(): JSX.Element {
  const slug = useHashSlug();
  const page = findPage(slug);

  // Scroll the page back to the top whenever the route changes so a
  // long page does not strand the reader mid-document on the new
  // page.
  const previousSlug = useRef<string | null>(null);
  useEffect(() => {
    if (previousSlug.current !== null && previousSlug.current !== slug) {
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    }
    previousSlug.current = slug;
  }, [slug]);

  // Set the document title to the active page's title so browser
  // tabs are scannable.
  useEffect(() => {
    if (page !== null) {
      document.title = `${page.title} · ChordSketch Docs`;
    } else {
      document.title = 'ChordSketch Docs';
    }
  }, [page]);

  return (
    <div className="docs-shell">
      <header className="docs-topbar">
        <a className="docs-brand" href="../">
          <span className="docs-brand-mark" aria-hidden="true" />
          <span className="docs-brand-text">
            ChordSketch <span className="docs-brand-section">Docs</span>
          </span>
        </a>
        <nav className="docs-topnav" aria-label="Site sections">
          <a className="docs-topnav-link" href="../">
            Home
          </a>
          <a className="docs-topnav-link" href="../chordpro/">
            ChordPro
          </a>
          <a className="docs-topnav-link" href="../irealpro/">
            iReal Pro
          </a>
          <a
            className="docs-topnav-link is-current"
            href="./"
            aria-current="page"
          >
            Docs
          </a>
          <a
            className="docs-topnav-link"
            href="https://github.com/koedame/chordsketch"
            target="_blank"
            rel="noreferrer noopener"
          >
            GitHub
          </a>
        </nav>
      </header>
      <div className="docs-body">
        <Sidebar activeSlug={slug} activePage={page} />
        <main className="docs-content" id="docs-content">
          {page !== null ? (
            <ArticleErrorBoundary slug={slug}>
              <Article page={page} />
            </ArticleErrorBoundary>
          ) : (
            <NotFound slug={slug} />
          )}
        </main>
      </div>
    </div>
  );
}

interface SidebarProps {
  activeSlug: string;
  activePage: DocPage | null;
}

function Sidebar({ activeSlug, activePage }: SidebarProps): JSX.Element {
  const outline = useMemo(
    () => (activePage !== null ? extractOutline(activePage.source) : []),
    [activePage],
  );
  return (
    <aside className="docs-sidebar" aria-label="Documentation navigation">
      <nav className="docs-nav">
        {DOC_GROUPS.map((group) => (
          <section key={group.label} className="docs-nav-group">
            <h2 className="docs-nav-group-label">{group.label}</h2>
            <ul className="docs-nav-list">
              {group.pages.map((page) => {
                const isActive = page.slug === activeSlug;
                return (
                  <li key={page.slug || '__index'}>
                    <a
                      className={
                        isActive
                          ? 'docs-nav-link is-active'
                          : 'docs-nav-link'
                      }
                      aria-current={isActive ? 'page' : undefined}
                      href={hrefForSlug(page.slug)}
                    >
                      {page.title}
                    </a>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </nav>
      {outline.length > 1 ? (
        <nav className="docs-outline" aria-label="On this page">
          <h2 className="docs-outline-label">On this page</h2>
          <ul className="docs-outline-list">
            {outline.map((entry) => (
              <li
                key={entry.id}
                className={entry.level === 3 ? 'is-level-3' : 'is-level-2'}
              >
                <a className="docs-outline-link" href={`#${entry.id}`}>
                  {entry.text}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
    </aside>
  );
}

interface ArticleProps {
  page: DocPage;
}

function Article({ page }: ArticleProps): JSX.Element {
  const html = useMemo(
    () => renderMarkdown(page.source, page.sourcePath),
    [page.source, page.sourcePath],
  );
  return (
    <article className="docs-article" data-page-slug={page.slug || 'index'}>
      <div
        className="docs-prose"
        // The Markdown source is bundled at build time from the
        // repo's own `docs/sdk/` tree and passes through
        // DOMPurify before reaching this attribute (see
        // `markdown.ts`). Trusted input + sanitiser
        // belt-and-braces.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </article>
  );
}

interface ArticleErrorBoundaryProps {
  slug: string;
  children: ReactNode;
}

interface ArticleErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches throws from `renderMarkdown` so a malformed Markdown
 * source or a future marked / DOMPurify regression surfaces a
 * scoped error panel instead of unmounting the whole docs SPA.
 * Reset key is the page slug — a new slug clears the error state
 * so subsequent navigation tries the next page cleanly.
 */
class ArticleErrorBoundary extends Component<
  ArticleErrorBoundaryProps,
  ArticleErrorBoundaryState
> {
  state: ArticleErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ArticleErrorBoundaryState {
    return { error };
  }

  componentDidUpdate(prevProps: ArticleErrorBoundaryProps): void {
    if (prevProps.slug !== this.props.slug && this.state.error !== null) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface the failure in the dev console so the maintainer
    // sees the stack trace; the user-visible panel below shows
    // the human-readable message only.
    // eslint-disable-next-line no-console
    console.error('docs article render failed', error, info);
  }

  render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <article className="docs-article docs-article-empty">
          <h1>Failed to render this page</h1>
          <p role="alert">{this.state.error.message}</p>
          <p>
            <a href={hrefForSlug('')}>Return to the docs home</a>.
          </p>
        </article>
      );
    }
    return this.props.children;
  }
}

interface NotFoundProps {
  slug: string;
}

function NotFound({ slug }: NotFoundProps): JSX.Element {
  return (
    <article className="docs-article docs-article-empty">
      <h1>Page not found</h1>
      <p>
        No docs page is registered at <code>#{slug !== '' ? `/${slug}` : '/'}</code>.
      </p>
      <p>
        <a href={hrefForSlug('')}>Return to the docs home</a>.
      </p>
    </article>
  );
}
