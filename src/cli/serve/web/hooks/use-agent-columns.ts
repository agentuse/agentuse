import { useEffect, useState } from 'preact/hooks';

/**
 * The Agents tree's visible columns, as an ordered list of column ids. Columns
 * are user-managed (built-in `schedule`/`run` plus `meta:<key>` per metadata
 * key), so the choice lives in localStorage. Order is preserved (append on add)
 * and kept in sync across tabs like pins.
 *
 * Absent storage means "never customized" -> the default set. An explicit empty
 * array is respected (the user removed every column).
 */
const STORAGE_KEY = 'agentuse-agents-columns';
const DEFAULT_COLUMNS = ['schedule', 'run'];

function read(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return [...DEFAULT_COLUMNS];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [...DEFAULT_COLUMNS];
  } catch {
    return [...DEFAULT_COLUMNS];
  }
}

function write(columns: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(columns));
  } catch {
    /* storage unavailable (private mode); choice stays in-memory for the session */
  }
}

export function useAgentColumns(): {
  columns: string[];
  addColumn: (id: string) => void;
  removeColumn: (id: string) => void;
} {
  const [columns, setColumns] = useState<string[]>(() => read());

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setColumns(read());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const addColumn = (id: string) => {
    setColumns((prev) => {
      if (prev.includes(id)) return prev;
      const next = [...prev, id];
      write(next);
      return next;
    });
  };

  const removeColumn = (id: string) => {
    setColumns((prev) => {
      const next = prev.filter((c) => c !== id);
      write(next);
      return next;
    });
  };

  return { columns, addColumn, removeColumn };
}
