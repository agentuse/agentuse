import { useEffect, useState } from 'preact/hooks';

const STORAGE_KEY = 'agentuse-sessions-last-visit';

function read(store: Storage | undefined): number | null {
  try {
    const stored = Number(store?.getItem(STORAGE_KEY));
    return Number.isFinite(stored) && stored > 0 ? stored : null;
  } catch {
    // Private/restricted contexts deny storage; the feed just shows no divider.
    return null;
  }
}

function write(store: Storage | undefined, value: number): void {
  try {
    store?.setItem(STORAGE_KEY, String(value));
  } catch {
    // Same as above: losing the mark costs a divider, nothing more.
  }
}

/** Epoch ms of the reader's previous visit to the sessions feed, or null when
 *  this browser has no record of one (first visit, or storage denied).
 *
 *  Deliberately a single number, not per-session read state: the feed draws one
 *  "new since your last visit" divider from it and nothing else, so there is no
 *  read/unread bookkeeping to maintain, sync, or clean up.
 *
 *  The mark has to hold still for as long as the reader is working, or it
 *  erases the very line they were using. Two things move it, and only two:
 *  a *new* tab or return to the app reads the mark left behind when the last
 *  one was closed, and closing the page leaves a fresh mark for next time.
 *  Opening a session and coming back, or hitting refresh, is how a feed gets
 *  read: the visit's anchor is pinned in sessionStorage (which outlives a
 *  reload but not the tab) so neither disturbs the divider.
 */
export function useLastVisit(): number | null {
  const [lastVisit] = useState<number | null>(() => {
    if (typeof sessionStorage === 'undefined' || typeof localStorage === 'undefined') return null;
    const anchored = read(sessionStorage);
    if (anchored !== null) return anchored;
    const previous = read(localStorage);
    if (previous !== null) write(sessionStorage, previous);
    return previous;
  });

  useEffect(() => {
    // pagehide, not beforeunload: it is the event mobile Safari actually fires
    // when a tab is closed or discarded.
    const stamp = () => write(localStorage, Date.now());
    window.addEventListener('pagehide', stamp);
    return () => window.removeEventListener('pagehide', stamp);
  }, []);

  return lastVisit;
}
