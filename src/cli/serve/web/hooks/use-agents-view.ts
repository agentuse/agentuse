import { useEffect, useState } from 'preact/hooks';

/**
 * The Agents page's layout mode: the dense path tree for operators, or the
 * card gallery that leads with names and descriptions for presenting. Like
 * pins/columns the choice is per-browser, persisted, and synced across tabs.
 */
export type AgentsView = 'tree' | 'cards';

const STORAGE_KEY = 'agentuse-agents-view';

function read(): AgentsView {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'cards' ? 'cards' : 'tree';
  } catch {
    return 'tree';
  }
}

export function useAgentsView(): { view: AgentsView; setView: (view: AgentsView) => void } {
  const [view, setViewState] = useState<AgentsView>(() => read());

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setViewState(read());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setView = (next: AgentsView) => {
    setViewState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* storage unavailable (private mode); choice stays in-memory for the session */
    }
  };

  return { view, setView };
}
