import { useEffect, useState } from 'preact/hooks';

const STORAGE_KEY = 'agentuse:developer:showDebug';
const CHANGE_EVENT = 'agentuse-developer-debug-change';
let tabPreference = false;

function readPreference(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return tabPreference;
  }
}

/** Shared, opt-in visibility for extra developer diagnostics across the web UI. */
export function useDeveloperDebug() {
  const [showDeveloperDebug, setState] = useState(readPreference);

  useEffect(() => {
    const sync = () => setState(readPreference());
    const syncStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY || event.key === null) sync();
    };
    window.addEventListener('storage', syncStorage);
    window.addEventListener(CHANGE_EVENT, sync);
    sync();
    return () => {
      window.removeEventListener('storage', syncStorage);
      window.removeEventListener(CHANGE_EVENT, sync);
    };
  }, []);

  const setShowDeveloperDebug = (enabled: boolean) => {
    tabPreference = enabled;
    try {
      localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
    } catch {
      // Keep the preference for this tab when browser storage is unavailable.
    }
    setState(enabled);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  };

  return { showDeveloperDebug, setShowDeveloperDebug };
}
