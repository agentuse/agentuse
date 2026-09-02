import { useEffect, useState } from 'preact/hooks';

/**
 * Live tails ride one EventSource each, and a browser allows only a handful of
 * concurrent connections per host over HTTP/1.1. A manager page renders a whole
 * descendant tree, so the cap cannot be an index check the way a flat list does
 * it (`home.tsx` gives its first rows the ticker): slots are handed out here,
 * shared by every card at every depth, first mounted first served.
 */
const MAX_LIVE_TAILS = 3;

let granted = 0;
const waiting = new Set<() => void>();

function acquire(): boolean {
  if (granted >= MAX_LIVE_TAILS) return false;
  granted += 1;
  return true;
}

function release(): void {
  granted = Math.max(0, granted - 1);
  // Hand the freed slot to whoever is still waiting. Copied first because a
  // waiter that takes the slot removes itself from the set as it re-renders.
  for (const notify of [...waiting]) notify();
}

/**
 * Claim one of the shared live-tail slots while `wanted` holds. Returns whether
 * this caller got one; callers that miss out fall back to their static line and
 * are promoted automatically as earlier cards finish and release theirs.
 */
export function useTailSlot(wanted: boolean): boolean {
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (!wanted) {
      setHeld(false);
      return;
    }
    let mine = acquire();
    setHeld(mine);
    if (mine) return () => { release(); };

    const retry = () => {
      if (mine) return;
      mine = acquire();
      if (mine) setHeld(true);
    };
    waiting.add(retry);
    return () => {
      waiting.delete(retry);
      if (mine) release();
    };
  }, [wanted]);

  return held;
}
