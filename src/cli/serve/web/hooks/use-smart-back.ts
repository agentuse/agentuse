import { useEffect } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { reportWebUIPageView, webUIPageForPath } from '../lib/api';

/**
 * How many in-app history entries sit behind the current one — i.e. how many
 * times we can safely `history.back()` and still land on a page this SPA
 * pushed. Module-scoped so it survives route changes but resets to 0 on a full
 * page load (cold open, push-notification deep-link, reload) — which is exactly
 * when there is no in-app history and `history.back()` would leave the app.
 */
let depth = 0;
const PAGE_VIEW_DEDUPE_MS = 15 * 60 * 1000;
const reportedPages = new Map<string, number>();

/**
 * Mount once inside <LocationProvider>. Keeps {@link depth} in sync with
 * navigation using preact-iso's `wasPush` (true on forward pushes) and a
 * popstate listener (fires on back/forward). Renders nothing.
 */
export function NavTracker() {
  // preact-iso exposes `wasPush` at runtime but omits it from LocationHook's type.
  const { url, wasPush } = useLocation() as ReturnType<typeof useLocation> & { wasPush: boolean };
  // Forward navigation (link click or programmatic route()) deepens the stack.
  // The initial render has wasPush=false, so a cold load leaves depth at 0.
  useEffect(() => {
    if (wasPush) depth += 1;
  }, [url, wasPush]);
  useEffect(() => {
    const page = webUIPageForPath(new URL(url, location.origin).pathname);
    const now = Date.now();
    if (now - (reportedPages.get(page) ?? 0) < PAGE_VIEW_DEDUPE_MS) return;
    reportedPages.set(page, now);
    reportWebUIPageView(page);
  }, [url]);
  // A pop (back/forward button, or our own history.back()) shrinks it.
  useEffect(() => {
    const onPop = () => {
      depth = Math.max(0, depth - 1);
    };
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);
  return null;
}

/**
 * Returns a click handler for a "back" control on a detail page. When there is
 * in-app history it does `history.back()`, returning to the *actual* origin
 * (the list, schedule, palette, wherever) with its scroll and filter state
 * intact — not a hardcoded parent. When there is none (deep-link / cold load /
 * installed PWA opened from a notification) it falls back to `fallbackHref`, so
 * the control is never a dead end.
 *
 * Keep a real `href={fallbackHref}` on the anchor: the handler bails on
 * modified clicks so ⌘/ctrl/middle-click still open the fallback in a new tab,
 * and it works with JS disabled. `stopPropagation` prevents preact-iso's global
 * click listener (which does not check `defaultPrevented`) from also
 * navigating to the href.
 */
export function useSmartBack(fallbackHref: string): (e: MouseEvent) => void {
  const { route } = useLocation();
  return (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (depth > 0) history.back();
    else route(fallbackHref, true);
  };
}
