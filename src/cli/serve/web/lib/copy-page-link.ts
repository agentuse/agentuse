import { fetchInfo } from './api';

/** Fired by the Mac app's Edit ▸ Copy Link to Page menu item and by the web
 *  ⌘⇧C handler; CopyLinkToast owns the actual copy so both paths share one
 *  implementation and one confirmation. */
export const COPY_PAGE_LINK_EVENT = 'agentuse:copy-page-link';

export function isCopyPageLinkShortcut(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): boolean {
  return !event.altKey && event.shiftKey && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c';
}

/** Base URL + the page's path, query and hash. The base is the daemon's public
 *  URL when it has one (serve.publicUrl / --public-url), else the page origin.
 *  The Mac app loads the dashboard from 127.0.0.1, so its origin is never the
 *  right thing to share. */
export function pageLinkFor(publicUrl: string | undefined, href: string): string {
  const page = new URL(href);
  const route = `${page.pathname}${page.search}${page.hash}`;
  if (!publicUrl?.trim()) return `${page.origin}${route}`;
  const base = new URL(publicUrl);
  return `${base.origin}${base.pathname.replace(/\/$/, '')}${route}`;
}

let cachedPublicUrl: Promise<string | undefined> | null = null;

/** Resolved once per page load; a failed lookup (auth-scoped deep link, daemon
 *  restarting) falls back to the page origin rather than blocking the copy. */
export function currentPageLink(): Promise<string> {
  cachedPublicUrl ??= fetchInfo().then((info) => info.publicUrl, () => undefined);
  return cachedPublicUrl.then((publicUrl) => pageLinkFor(publicUrl, window.location.href));
}
