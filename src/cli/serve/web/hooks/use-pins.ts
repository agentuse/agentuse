import { useEffect, useState } from 'preact/hooks';

/**
 * Client-side "pin to top" preference for the Agents view. There is no server
 * field for this, so pins live in localStorage keyed by `${projectId}::${path}`
 * and are kept in pin order (newest last) so the Pinned section stays stable.
 */
const STORAGE_KEY = 'agentuse-pinned-agents';

interface PinnableAgent {
  projectId: string;
  path: string;
}

function keyFor(a: PinnableAgent): string {
  return `${a.projectId}::${a.path}`;
}

function read(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function usePins(): {
  keys: string[];
  isPinned: (a: PinnableAgent) => boolean;
  toggle: (a: PinnableAgent) => void;
} {
  const [keys, setKeys] = useState<string[]>(() => read());

  // Keep multiple tabs in sync.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setKeys(read());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const isPinned = (a: PinnableAgent) => keys.includes(keyFor(a));

  const toggle = (a: PinnableAgent) => {
    const k = keyFor(a);
    setKeys((prev) => {
      const next = prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k];
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable (private mode); pins stay in-memory for the session */
      }
      return next;
    });
  };

  return { keys, isPinned, toggle };
}
