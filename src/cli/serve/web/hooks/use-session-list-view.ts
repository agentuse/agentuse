import { useEffect, useState } from 'preact/hooks';

export type SessionListView = 'summary' | 'feed';

const STORAGE_KEY = 'agentuse-session-list-view';
const CHANGE_EVENT = 'agentuse-session-list-view-change';

/* The feed cards are the calm-console default; compact summary rows are the
   stored deviation. */
function readView(): SessionListView {
  if (typeof localStorage === 'undefined') return 'feed';
  try {
    return localStorage.getItem(STORAGE_KEY) === 'summary' ? 'summary' : 'feed';
  } catch {
    return 'feed';
  }
}

export function useSessionListView(): {
  view: SessionListView;
  setView: (view: SessionListView) => void;
} {
  const [view, setViewState] = useState<SessionListView>(() => readView());

  useEffect(() => {
    const sync = (event: Event) => {
      const chosen = event instanceof CustomEvent && (event.detail === 'summary' || event.detail === 'feed')
        ? event.detail
        : readView();
      setViewState(chosen);
    };
    window.addEventListener('storage', sync);
    window.addEventListener(CHANGE_EVENT, sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(CHANGE_EVENT, sync);
    };
  }, []);

  const setView = (next: SessionListView) => {
    try {
      if (next === 'feed') localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Browsers can deny localStorage in private/restricted contexts. The
      // current tab still gets the chosen mode even when it cannot persist.
    }
    setViewState(next);
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: next }));
  };

  return { view, setView };
}
